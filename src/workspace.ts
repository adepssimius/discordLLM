import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "./session/types.js";

/**
 * Where the agent stands.
 *
 * Two shapes are in use. Most bots have one directory shared by every thread:
 * its CLAUDE.md is the bot's notes, which Claude Code loads into every
 * conversation by itself, so what the agent writes there is known in the next
 * thread without anyone repeating it. `sharedWorkspace` is that.
 *
 * A bot whose job is editing files gives each thread a directory of its own —
 * a clone on its own branch — and implements this interface itself.
 *
 * The path a session resolves to must never change: the SDK files a
 * transcript under the directory it ran in, and resuming looks there.
 */
export interface WorkspaceProvider {
  /** Makes sure the session's directory exists. `created` is true when this call made it. */
  ensure(session: Session): Promise<{ dir: string; created: boolean }>;
  /** The session's directory, whether or not it exists yet. */
  dirFor(session: Session): string;
  /** Housekeeping, at startup and every few hours. Must not throw for one bad entry. */
  maintain?(): Promise<void>;
}

export const NOTES_FILE = "CLAUDE.md";

export interface SharedWorkspaceOptions {
  /** Absolute path. */
  readonly dir: string;
  /** What `CLAUDE.md` starts as. Written once and never overwritten. */
  readonly notesSeed?: string;
  /** Subdirectories to create, relative to `dir`. */
  readonly dirs?: readonly string[];
  /** Subdirectories whose files are deleted once older than `retentionDays`. */
  readonly prune?: readonly string[];
  readonly retentionDays?: number;
  readonly onPruned?: (removed: number) => void;
}

export interface SharedWorkspace extends WorkspaceProvider {
  readonly dir: string;
  /** Creates the directory and seeds the notes. Idempotent; called at startup. */
  init(): Promise<{ dir: string; seeded: boolean }>;
}

/** One directory for every thread, with notes the agent keeps. */
export function sharedWorkspace(opts: SharedWorkspaceOptions): SharedWorkspace {
  let ready: Promise<{ dir: string; seeded: boolean }> | undefined;

  const init = async (): Promise<{ dir: string; seeded: boolean }> => {
    await mkdir(opts.dir, { recursive: true });
    for (const d of opts.dirs ?? []) await mkdir(join(opts.dir, d), { recursive: true });
    if (opts.notesSeed === undefined) return { dir: opts.dir, seeded: false };
    const notes = join(opts.dir, NOTES_FILE);
    try {
      await access(notes);
      return { dir: opts.dir, seeded: false };
    } catch {
      // `wx`: if two processes race, the loser fails instead of clobbering.
      await writeFile(notes, opts.notesSeed, { flag: "wx" }).catch(() => undefined);
      return { dir: opts.dir, seeded: true };
    }
  };

  return {
    dir: opts.dir,
    init: () => (ready ??= init()),
    async ensure() {
      await (ready ??= init());
      // Shared, so never "new" from a thread's point of view.
      return { dir: opts.dir, created: false };
    },
    dirFor: () => opts.dir,
    async maintain() {
      if (!opts.prune || opts.prune.length === 0 || !opts.retentionDays) return;
      let removed = 0;
      for (const d of opts.prune) removed += await pruneOlderThan(join(opts.dir, d), opts.retentionDays);
      if (removed > 0) opts.onPruned?.(removed);
    },
  };
}

/** Deletes files older than the retention window, and the directories that leaves empty. */
export async function pruneOlderThan(root: string, days: number, now = Date.now()): Promise<number> {
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        if ((await readdir(p).catch(() => ["x"])).length === 0) await rm(p, { recursive: true }).catch(() => undefined);
        continue;
      }
      const s = await stat(p).catch(() => undefined);
      if (s && s.mtimeMs < cutoff) {
        await rm(p).catch(() => undefined);
        removed += 1;
      }
    }
  };
  await walk(root);
  return removed;
}

/** Files written under `dir` since `since` — what a turn generated, for the bot to post. */
export async function filesSince(dir: string, since: number): Promise<string[]> {
  try {
    const names = await readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      const p = join(dir, n);
      const st = await stat(p).catch(() => undefined);
      // A second's slack for filesystems with coarse timestamps.
      if (st?.isFile() && st.mtimeMs >= since - 1000) out.push(p);
    }
    return out.sort();
  } catch {
    return [];
  }
}
