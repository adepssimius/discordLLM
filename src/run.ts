import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { assembleProfiles, maintainProfiles } from "./assemble.js";
import { claudeAgent } from "./backends/claude/index.js";
import { ConfigError, loadCore, requireDiscord, storeTarget } from "./config.js";
import type { BotDefinition } from "./definition.js";
import { DiscordBot } from "./discord/bot.js";
import { createServer } from "./http/server.js";
import { createLogger } from "./logger.js";
import { Profiles } from "./profile.js";
import { QuotaGuard } from "./quota/budget.js";
import { Scheduler } from "./schedule/scheduler.js";
import { recoverInterrupted } from "./session/manager.js";
import { openStore } from "./store/index.js";

/**
 * The whole bot: a bot's `main.ts` is `run(definition)`.
 *
 * Order matters. The database and recovery come before the Discord gateway,
 * so nothing races them; the scheduler and the HTTP probes come after it, so
 * `/readyz` is only green once the bot can be reached.
 */
export async function run<S extends z.ZodRawShape>(def: BotDefinition<S>): Promise<void> {
  const cfg = loadCore(def);
  const backend = def.backend ?? claudeAgent();
  const log = createLogger({
    level: cfg.LOG_LEVEL,
    pretty: cfg.LOG_PRETTY,
    secrets: [...backend.secrets, ...(def.secrets ?? [])],
  });

  const ready = backend.ready(process.env);
  if (!ready.ok) {
    log.error(ready.problem);
    process.exit(1);
  }
  if (ready.warning) log.warn(ready.warning);

  const discord = requireDiscord();

  const target = storeTarget(cfg, (e) => log.warn({ err: e }, "database connection error"));
  if (target.kind === "sqlite") mkdirSync(dirname(target.path), { recursive: true });
  const store = await openStore(target);
  const quota = new QuotaGuard(cfg, log, store);

  const built = await assembleProfiles(def, { core: cfg, log, store, quota, backend, requireAuthz: true });
  if (built.length === 0) {
    log.error("no usable profile — nothing to serve");
    process.exit(1);
  }
  if (built.length > 1) {
    const unowned = built.filter((p) => p.cfg.DISCORD_CHAT_CHANNEL_IDS.length === 0).map((p) => p.cfg.name);
    if (unowned.length > 0) {
      log.error({ profiles: unowned }, "with several profiles each needs DISCORD_CHAT_CHANNEL_IDS — these own no channel");
    }
  }
  const profiles = new Profiles(built);

  // An installation that has just been given named profiles has rows stamped
  // `default`. They belong to the first profile — the same people, renamed.
  if (!built.some((p) => p.cfg.name === "default")) {
    const to = profiles.first.cfg.name;
    const moved = (await store.sessions.relabelProfile("default", to)) + (await store.schedules.relabelProfile("default", to));
    if (moved > 0) log.info({ to, rows: moved }, "adopted rows from the unnamed profile");
  }

  log.info(
    {
      backend: backend.name,
      model: cfg.AGENT_MODEL ?? "default",
      credentials: ready.source,
      profiles: built.map((p) => p.cfg.name),
      database: target.kind === "sqlite" ? target.path : `postgres${target.schema ? ` (schema ${target.schema})` : ""}`,
      dataDir: cfg.DATA_DIR,
      turnsPerHour: cfg.AGENT_TURNS_PER_HOUR,
      maxConcurrent: cfg.AGENT_MAX_CONCURRENT_RUNS,
    },
    `${def.name} starting`,
  );

  // Recovery runs before the gateway connects, so nothing races it.
  const recovered = await recoverInterrupted(store, log);

  const bot = new DiscordBot({ cfg, def, discord, log, store, profiles });
  await bot.start(recovered.interrupted);

  const scheduler = new Scheduler(
    cfg,
    log,
    store,
    (s) => profiles.named(s.profile).cfg.BOT_TIMEZONE,
    (s) => {
      void bot.postBrief(s).catch((e: unknown) => log.error({ err: e, schedule: s.name }, "brief failed"));
    },
    () => maintainProfiles(def, built, log),
  );
  await scheduler.start();

  const server = createServer({ quota, isReady: () => bot.isConnected(), metricPrefix: def.name });
  server.listen(cfg.HTTP_PORT, cfg.HTTP_BIND, () => {
    log.info({ port: cfg.HTTP_PORT, bind: cfg.HTTP_BIND }, "http listening");
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    scheduler.stop();
    server.close();
    void bot
      .stop()
      .catch(() => undefined)
      .then(() => store.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/** `run`, with the error handling a `main.ts` wants. */
export function main<S extends z.ZodRawShape>(def: BotDefinition<S>): void {
  run(def).catch(fatal);
}

export function fatal(err: unknown): never {
  // A misconfigured environment is an operator error; a stack trace buries the
  // one line that says which variable is missing.
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
