import { mkdir } from "node:fs/promises";
import type { z } from "zod";
import { loadProfiles, type Config, type CoreConfig } from "./config.js";
import type { AgentBackend } from "./agent/backend.js";
import type { BotDefinition, Domain } from "./definition.js";
import { authorisesSomeone } from "./discord/authz.js";
import type { Logger } from "./logger.js";
import type { Profile } from "./profile.js";
import type { QuotaGuard } from "./quota/budget.js";
import { SessionManager } from "./session/manager.js";
import type { Store } from "./store/index.js";
import { pruneOlderThan, sharedWorkspace, type WorkspaceProvider } from "./workspace.js";

/**
 * Builds every profile: reads its settings, asks the bot for its domain, and
 * gives it a session manager. Shared by the Discord entry point and the REPL,
 * so what is tried from a terminal is what runs in the pod.
 *
 * A profile that cannot work is skipped with a logged reason, so one
 * profile's misconfiguration does not take the others down with it.
 */
export async function assembleProfiles<S extends z.ZodRawShape>(
  def: BotDefinition<S>,
  deps: {
    readonly core: CoreConfig;
    readonly log: Logger;
    readonly store: Store;
    readonly quota?: QuotaGuard;
    readonly backend: AgentBackend;
    /** False for the REPL, where there is no channel to gate on. */
    readonly requireAuthz: boolean;
  },
): Promise<Profile[]> {
  const { core, log, store, quota } = deps;
  const shared = def.prepare ? await def.prepare({ cfg: core, log }) : undefined;

  const profiles: Profile[] = [];
  for (const loaded of loadProfiles(def, core)) {
    const cfg: Config = loaded.cfg;
    const plog = log.child({ profile: cfg.name });

    // Either a channel of its own (Discord's permissions decide who is in it)
    // or an explicit allowlist. Neither would mean anyone on the server could
    // spend the subscription and act through the bot.
    if (
      deps.requireAuthz &&
      !authorisesSomeone({
        userIds: cfg.DISCORD_CHAT_USER_IDS,
        roleIds: cfg.DISCORD_CHAT_ROLE_IDS,
        channelGated: cfg.DISCORD_CHAT_CHANNEL_IDS.length > 0,
      })
    ) {
      plog.error("no DISCORD_CHAT_CHANNEL_IDS and no DISCORD_CHAT_USER_IDS / DISCORD_CHAT_ROLE_IDS — anyone could use this profile; skipped");
      continue;
    }

    let domain: Domain;
    try {
      domain = await def.setup({
        cfg,
        env: loaded.env,
        log: plog,
        shared,
        sessions: { byId: (id) => store.sessions.byId(id) },
      });
    } catch (e) {
      plog.error({ err: e }, "profile could not be set up; skipped");
      continue;
    }

    const workspace: WorkspaceProvider = domain.workspace ?? sharedWorkspace({ dir: cfg.workDir });
    if (def.attachments) await mkdir(cfg.inboxDir, { recursive: true });

    const manager = new SessionManager({
      cfg,
      log: plog,
      store,
      def,
      backend: deps.backend,
      domain,
      workspace,
      ...(quota ? { quota } : {}),
    });
    profiles.push({ cfg, domain, workspace, manager });

    plog.info(
      {
        servers: Object.keys(domain.servers),
        timeZone: cfg.BOT_TIMEZONE,
        approvalLevel: cfg.APPROVAL_LEVEL,
        approvers: cfg.DISCORD_APPROVER_USER_IDS.length + cfg.DISCORD_APPROVER_ROLE_IDS.length || "same as chat",
        channels: cfg.DISCORD_CHAT_CHANNEL_IDS.length || "any",
        ...domain.startup,
      },
      "profile ready",
    );
  }
  return profiles;
}

/** Each profile's housekeeping, plus the inbox of a bot that takes posted files. */
export async function maintainProfiles(
  def: Pick<BotDefinition, "attachments">,
  profiles: readonly Profile[],
  log: Logger,
): Promise<void> {
  for (const p of profiles) {
    try {
      await p.workspace.maintain?.();
      if (def.attachments) {
        const removed = await pruneOlderThan(p.cfg.inboxDir, p.cfg.INBOX_RETENTION_DAYS);
        if (removed > 0) log.info({ profile: p.cfg.name, removed, days: p.cfg.INBOX_RETENTION_DAYS }, "pruned old inbox files");
      }
    } catch (e) {
      log.warn({ err: e, profile: p.cfg.name }, "housekeeping failed for a profile");
    }
  }
}
