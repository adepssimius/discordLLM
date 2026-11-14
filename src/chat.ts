import { createInterface } from "node:readline/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { assembleProfiles } from "./assemble.js";
import { claudeAgent } from "./backends/claude/index.js";
import { loadCore, storeTarget } from "./config.js";
import type { BotDefinition } from "./definition.js";
import { buildCard } from "./discord/approvalCard.js";
import { isImage, safeName } from "./discord/files.js";
import { createLogger } from "./logger.js";
import { QuotaGuard } from "./quota/budget.js";
import { renderPromptReport } from "./inspect.js";
import { fatal } from "./run.js";
import { recoverInterrupted } from "./session/manager.js";
import type { PostedFile } from "./session/types.js";
import { openStore } from "./store/index.js";
import type { Approver } from "./agent/approval.js";

/**
 * Headless chat REPL — the same session manager, policy and tools Discord
 * uses, driven from stdin. No Discord token and no bot in a guild. A bot's
 * `chat.ts` is `chat(definition)`.
 *
 * Approval requests are printed as they would appear in Discord and answered
 * by CHAT_APPROVE: `never` (the default — everything needing approval is
 * refused) or `always`. Exploring is safe with the default.
 *
 * Restarting the process continues the same conversation, which is the
 * behaviour a Discord thread has across a pod restart. With several profiles,
 * CHAT_PROFILE picks one; the first is the default.
 *
 * Commands: /new  /stop  /stats  /quit
 *   /prompt          what the agent is told in this session (no model call)
 *   /attach <path>   post a local file with your next message (bots that take files)
 *
 * `chat --prompt` prints that and exits, without a model credential: the way
 * to see what an edit to a prompt section did. Add `--brief` for what a
 * scheduled run is told.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export async function runChat<S extends z.ZodRawShape>(def: BotDefinition<S>): Promise<void> {
  const cfg = loadCore(def);
  const backend = def.backend ?? claudeAgent();
  const log = createLogger({ level: cfg.LOG_LEVEL, pretty: true, secrets: [...backend.secrets, ...(def.secrets ?? [])] });

  const ready = backend.ready(process.env);
  if (!ready.ok) {
    console.error(ready.problem);
    process.exit(1);
  }

  const target = storeTarget(cfg);
  if (target.kind === "sqlite") mkdirSync(dirname(target.path), { recursive: true });
  const store = await openStore(target);
  const quota = new QuotaGuard(cfg, log, store, {
    onWarning: (_i, msg) => console.log(`${YELLOW}[quota] ${msg}${RESET}`),
    onCooldown: (_c, msg) => console.log(`${RED}[quota] ${msg}${RESET}`),
    onCooldownCleared: () => console.log(`${DIM}[quota] cooldown cleared${RESET}`),
  });

  const built = await assembleProfiles(def, { core: cfg, log, store, quota, backend, requireAuthz: false });
  const wanted = process.env.CHAT_PROFILE;
  const profile = wanted ? built.find((p) => p.cfg.name === wanted) : built[0];
  if (!profile) {
    console.error(wanted ? `No usable profile named '${wanted}'.` : "No usable profile — see the log lines above.");
    process.exit(1);
  }
  const { manager, domain } = profile;
  const pcfg = profile.cfg;

  if (Object.keys(domain.servers).length === 0) {
    console.log(`${YELLOW}No MCP servers are configured for this profile — the agent has only its built-in tools.${RESET}`);
  }

  const approveAll = process.env.CHAT_APPROVE === "always";
  const style = {
    tiers: def.tiers ?? [],
    tierLabels: def.tierLabels,
    describe: domain.describe ? (c: Parameters<NonNullable<typeof domain.describe>>[0]) => domain.describe?.(c) : undefined,
  };
  const approver: Approver = async (req) => {
    const card = buildCard(style, req);
    console.log(`\n${YELLOW}[${card.title}] ${card.summary}${RESET}\n${DIM}${card.reason}\n${card.detail}${RESET}`);
    console.log(approveAll ? `${YELLOW}→ approved (CHAT_APPROVE=always)${RESET}` : `${RED}→ refused (CHAT_APPROVE=never)${RESET}`);
    return approveAll
      ? { approved: true, by: "repl-user" }
      : { approved: false, by: null, reason: "the dev REPL refuses changes unless CHAT_APPROVE=always" };
  };

  // Boot recovery before accepting input, exactly as the pod will.
  const recovered = await recoverInterrupted(store, log);
  if (recovered.interrupted.length > 0) {
    console.log(
      `${YELLOW}${recovered.interrupted.length} session(s) had a turn interrupted by a restart; it was not retried.${RESET}`,
    );
  }

  const open = (threadId: string) =>
    manager.openChat({ guildId: "repl", channelId: "repl", threadId, openedBy: "repl-user", title: "repl" });

  const threadId = process.env.CHAT_THREAD_ID ?? "repl-thread";
  let session = await open(threadId);

  console.log(
    `${DIM}${def.name} · profile ${pcfg.name} · session ${session.id.slice(0, 8)} · ` +
      `db ${target.kind === "sqlite" ? target.path : "postgres"}${RESET}`,
  );
  console.log(
    `${DIM}${backend.name} · model ${cfg.AGENT_MODEL ?? "default"} · auth ${ready.source} · ` +
      `servers ${Object.keys(domain.servers).join(", ") || "none"} · ` +
      `approval ${pcfg.APPROVAL_LEVEL}/${approveAll ? "always" : "never"} · /new /stop /stats /prompt${def.attachments ? " /attach" : ""} /quit${RESET}\n`,
  );

  // Async-iterator form rather than repeated question(): it terminates cleanly
  // at EOF, so the same REPL works with piped input in a scripted test.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("› ");

  // With piped input, readline reaches EOF and emits `close` while an agent
  // turn is still awaiting, so prompting unguarded throws ERR_USE_AFTER_CLOSE.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = (): void => {
    if (!closed) rl.prompt();
  };

  prompt();

  const pending: PostedFile[] = [];
  for await (const raw of rl) {
    const line = raw.trim();
    if (line.length === 0) {
      prompt();
      continue;
    }

    if (line === "/quit" || line === "/exit") break;

    if (line === "/new") {
      session = await open(`repl-${randomUUID().slice(0, 8)}`);
      console.log(`${DIM}new session ${session.id.slice(0, 8)}${RESET}\n`);
      prompt();
      continue;
    }

    if (line.startsWith("/attach ")) {
      if (!def.attachments) {
        console.log(`${RED}this bot does not take posted files${RESET}\n`);
        prompt();
        continue;
      }
      const src = line.slice("/attach ".length).trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
      try {
        const st = await stat(src);
        const dir = join(pcfg.inboxDir, session.id);
        await mkdir(dir, { recursive: true });
        const dest = join(dir, safeName(`repl${Date.now()}`, pending.length, basename(src)));
        await copyFile(src, dest);
        pending.push({
          path: relative(pcfg.workDir, dest),
          name: basename(src),
          contentType: null,
          bytes: st.size,
          image: isImage(null, src),
        });
        console.log(`${DIM}attached ${basename(src)} — it goes with your next message${RESET}\n`);
      } catch (e) {
        console.log(`${RED}cannot attach ${src}: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
      }
      prompt();
      continue;
    }

    if (line === "/stop") {
      manager.abort(session.id);
      console.log(`${DIM}abort flag set — the current run will stop at its next tool call${RESET}\n`);
      prompt();
      continue;
    }

    if (line === "/prompt") {
      session = (await store.sessions.byId(session.id)) ?? session;
      console.log(`\n${renderPromptReport(await manager.inspect({ session, actorId: "repl-user" }), pcfg.BOT_TIMEZONE)}`);
      prompt();
      continue;
    }

    if (line === "/stats") {
      const s = await store.sessions.byId(session.id);
      const q = await quota.status();
      console.log(
        `${DIM}messages ${s?.turnCount ?? 0} · agent turns ${s?.agentTurnCount ?? 0} · ` +
          `cost $${(s?.costUsd ?? 0).toFixed(4)}${RESET}`,
      );
      console.log(
        `${DIM}quota ${q.spentLastHour}/${q.hourlyLimit} turns this hour · ` +
          `concurrency ${q.inFlight}/${q.concurrencyLimit}${q.queued > 0 ? ` · ${q.queued} queued` : ""}` +
          `${q.cooldown ? ` · COOLDOWN until ${new Date(q.cooldown.until).toISOString()}` : ""}${RESET}\n`,
      );
      prompt();
      continue;
    }

    // Re-read so counters and agentSessionId reflect the previous turn.
    session = (await store.sessions.byId(session.id)) ?? session;

    const started = Date.now();
    let printedToolHeader = false;

    const result = await manager.runChatTurn(
      {
        session,
        trigger: session.turnCount === 0 ? "mention" : "thread_message",
        actorId: "repl-user",
        message: { authorDisplayName: "repl-user", content: line },
        files: pending.splice(0, pending.length),
        approver,
      },
      {
        onToolUse: (name, input) => {
          if (!printedToolHeader) {
            process.stdout.write("\n");
            printedToolHeader = true;
          }
          const short = JSON.stringify(input);
          console.log(`${DIM}  🔧 ${name.replace(/^mcp__/, "")} ${short.slice(0, 120)}${RESET}`);
        },
        onToolSummary: (summary) => console.log(`${DIM}  ✓ ${summary}${RESET}`),
        onText: (t) => process.stdout.write(t),
        onRateLimit: (i) => {
          if (i.status !== "allowed") {
            console.log(
              `\n${YELLOW}[rate limit ${i.status}${i.rateLimitType ? ` · ${i.rateLimitType}` : ""}` +
                `${i.utilization !== undefined ? ` · ${Math.round(i.utilization * 100)}% used` : ""}]${RESET}`,
            );
          }
        },
      },
    );

    if (result.blocked) {
      console.log(`${RED}${result.message}${RESET}\n`);
      prompt();
      continue;
    }

    await manager.markDelivered(result.turnId, "repl");

    for (const g of result.generated) console.log(`${YELLOW}[file] ${g}${RESET}`);

    for (const p of result.polls) {
      console.log(`\n${YELLOW}[poll · ${p.key}${p.multi ? " · multi" : ""}] ${p.question}${RESET}`);
      p.options.forEach((o, i) => console.log(`${DIM}  ${i + 1}. ${o}${RESET}`));
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (result.contextRebuilt) {
      console.log(`\n${YELLOW}[earlier context was lost; answered from a rebuilt recap]${RESET}`);
    }
    if (!result.ok) {
      console.log(`\n${RED}[run failed] ${result.text}${RESET}`);
    }
    console.log(
      `\n${DIM}${secs}s · ${result.numTurns} turns · $${result.costUsd.toFixed(4)}` +
        `${result.deniedTools > 0 ? ` · ${result.deniedTools} denied` : ""}${RESET}\n`,
    );
    prompt();
  }

  if (!closed) rl.close();
  await store.close();
}

/**
 * Prints what the agent would be told, and exits. Nothing is sent to a model,
 * so no credential is needed; the bot's own variables are, since `setup` reads
 * them.
 */
export async function showPrompt<S extends z.ZodRawShape>(
  def: BotDefinition<S>,
  opts: { readonly brief?: boolean } = {},
): Promise<void> {
  const cfg = loadCore(def);
  const backend = def.backend ?? claudeAgent();
  // Quiet: the report is the output, and it may be piped to a file.
  const log = createLogger({ level: "warn", pretty: true, secrets: [...backend.secrets, ...(def.secrets ?? [])] });

  const target = storeTarget(cfg);
  if (target.kind === "sqlite") mkdirSync(dirname(target.path), { recursive: true });
  const store = await openStore(target);
  try {
    const built = await assembleProfiles(def, { core: cfg, log, store, backend, requireAuthz: false });
    const wanted = process.env.CHAT_PROFILE;
    const profile = wanted ? built.find((p) => p.cfg.name === wanted) : built[0];
    if (!profile) {
      console.error(wanted ? `No usable profile named '${wanted}'.` : "No usable profile.");
      process.exitCode = 1;
      return;
    }
    // The REPL's own thread, if it has been used: then the last turn is shown too.
    const session = opts.brief ? undefined : await store.sessions.byThread(process.env.CHAT_THREAD_ID ?? "repl-thread");
    const report = await profile.manager.inspect({ session, interactive: !opts.brief, actorId: opts.brief ? null : "repl-user" });
    process.stdout.write(renderPromptReport(report, profile.cfg.BOT_TIMEZONE));
  } finally {
    await store.close();
  }
}

/** `runChat`, with the error handling a `chat.ts` wants. `--prompt` prints the prompt instead. */
export function chat<S extends z.ZodRawShape>(def: BotDefinition<S>): void {
  const args = process.argv.slice(2);
  (args.includes("--prompt") ? showPrompt(def, { brief: args.includes("--brief") }) : runChat(def)).catch(fatal);
}
