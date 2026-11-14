import { join } from "node:path";
import { z } from "zod";
import type { BotDefinition } from "./definition.js";
import { approvalLevels, defaultApprovalLevel } from "./agent/tiers.js";

/**
 * Configuration, all of it from the environment.
 *
 * Three layers:
 *
 *  - **Core** settings are shared by the whole process: credentials, the
 *    quota, the database, timings.
 *  - **Profile** settings belong to one person or household being served: a
 *    Discord channel and who may talk there, a time zone, an approval level.
 *    One bot process can serve several profiles (`BOT_PROFILES=sam,alex`); each
 *    profile variable can then be set as `PROFILE_<NAME>_<VARIABLE>`, with the
 *    plain variable as the default for all of them. Without `BOT_PROFILES`
 *    there is one profile, `default`, read from the plain variables.
 *  - **The bot's own** variables (`BotDefinition.env`) — a server's URL and
 *    token — are per profile in the same way.
 *
 * Discord settings are validated lazily via requireDiscord(), so the headless
 * REPL runs without them. Nothing personal has a default here.
 */

export const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );

export const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const boolDefaultTrue = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");

/** Treats an empty string as unset, which is how an unfilled ConfigMap key arrives. */
export const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

/** The built-in tools a bot without a shell gets. ToolSearch stays in: Claude Code may defer MCP tool schemas behind it. */
export const DEFAULT_BUILTIN_TOOLS =
  "Read,Write,Edit,Glob,Grep,WebSearch,TodoWrite,ToolSearch,ListMcpResourcesTool,ReadMcpResourceTool";

const CoreSchema = z.object({
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  LOG_PRETTY: bool,

  /** Which model. Unset means the backend's default. */
  AGENT_MODEL: optionalString,
  /** Model round trips one Discord message may spend. */
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(60),
  /**
   * Built-in tools the agent may use, beyond the MCP servers, in the library's
   * vocabulary (agent/backend.ts). A backend offers the ones it has.
   */
  AGENT_BUILTIN_TOOLS: z
    .string()
    .default(DEFAULT_BUILTIN_TOOLS)
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),

  /** Everything that must survive a restart lives under here. */
  DATA_DIR: z.string().default("/data"),
  /**
   * Where the ledger is kept. By default a SQLite file under DATA_DIR
   * (SQLITE_PATH moves it). Set DATABASE_URL to a `postgres://` URL to use
   * Postgres instead; the bot then needs the `pg` package installed.
   * DATABASE_SCHEMA gives the bot a schema of its own, so several bots can
   * share one database. The URL carries a password: it is a secret.
   *
   * Either way DATA_DIR still has to persist: the SDK's transcripts and the
   * agent's working directory live there, not in the database.
   */
  SQLITE_PATH: optionalString,
  DATABASE_URL: optionalString,
  DATABASE_SCHEMA: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

  /**
   * Quota. On subscription auth these are availability controls, not cost
   * controls: exhausting the limit locks the operator out of their own editor.
   */
  AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),
  /** Budget denominated in SDK turns, the same unit the ledger records. */
  AGENT_TURNS_PER_HOUR: z.coerce.number().int().positive().default(300),
  /** Assumed cost of a run already in flight, so simultaneous starts can't all see zero. */
  AGENT_INFLIGHT_TURN_ESTIMATE: z.coerce.number().int().positive().default(10),
  /** Utilization (0–1) at which concurrency drops to 1 and a warning is posted. */
  QUOTA_WARN_UTILIZATION: z.coerce.number().min(0).max(1).default(0.8),

  /** Files people post in Discord, for a bot with `attachments` on. */
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  ATTACHMENTS_PER_MESSAGE: z.coerce.number().int().positive().default(10),
  /** Inbox files, and files posted back to Discord, older than this are deleted. */
  INBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** Post files the agent generates (see Domain.postFilesFrom) back to the thread. */
  POST_GENERATED_FILES: boolDefaultTrue,

  /** How long an approval request waits before it counts as a refusal. */
  APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),

  /** How often the scheduler looks for due briefs. */
  SCHEDULE_TICK_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * A brief that is this late (the pod was down) is skipped rather than run:
   * a morning brief delivered at dinner is noise.
   */
  SCHEDULE_MAX_LATE_MS: z.coerce.number().int().positive().default(3 * 3_600_000),
  /** Refuse schedules that would fire more often than this. */
  SCHEDULE_MIN_INTERVAL_MIN: z.coerce.number().int().positive().default(30),

  /** How long a poll stays open if nobody answers it. Discord's minimum is 1. */
  POLL_DURATION_HOURS: z.coerce.number().int().min(1).max(768).default(24),
  /**
   * How long after the last tap before a vote is taken as final. Short for a
   * single choice — just long enough to fix a mis-tap — and longer when
   * several answers may be picked, since each one is a separate tap.
   */
  POLL_SETTLE_MS: z.coerce.number().int().nonnegative().default(4_000),
  POLL_MULTI_SETTLE_MS: z.coerce.number().int().nonnegative().default(15_000),

  HTTP_PORT: z.coerce.number().int().positive().default(8080),
  HTTP_BIND: z.string().default("0.0.0.0"),
});

const DiscordSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_EDIT_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  DISCORD_MAX_MESSAGES_PER_TURN: z.coerce.number().int().positive().default(30),
  CHAT_PENDING_MAX: z.coerce.number().int().positive().default(5),
});

const ProfileSchema = z.object({
  /** IANA zone for schedules and for the date the agent is told it is. */
  BOT_TIMEZONE: z.string().default("UTC"),
  /**
   * The agent's working directory for a bot whose threads share one. Its
   * CLAUDE.md is the notes Claude Code loads into every conversation.
   */
  WORK_DIR: optionalString,
  /**
   * The lowest tier that waits for a person to press Approve — one of the
   * bot's tiers above the first, or `none`. Unset means only the top tier.
   */
  APPROVAL_LEVEL: optionalString,

  /**
   * Who may cause an agent turn. Optional when the profile has its own
   * channel: Discord's permissions on a private channel already decide who can
   * post there. Required when it answers in any channel.
   */
  DISCORD_CHAT_ROLE_IDS: csv,
  DISCORD_CHAT_USER_IDS: csv,
  /**
   * The channel(s) this profile answers in. With one profile, empty means any
   * channel; with several, a profile with no channel owns nothing.
   */
  DISCORD_CHAT_CHANNEL_IDS: csv,
  /**
   * Who may press Approve. A separate list from chat on purpose: being able to
   * ask need not mean being able to approve. Both empty means anyone allowed
   * to chat may approve.
   */
  DISCORD_APPROVER_USER_IDS: csv,
  DISCORD_APPROVER_ROLE_IDS: csv,
  /**
   * Whether `prompt` works in Discord: the bot posting what its agent is told.
   * Off, the word is an ordinary message. The REPL and `discordllm prompt` are
   * the operator's own terminal and are not affected.
   */
  PROMPT_INSPECTION: boolDefaultTrue,
  /**
   * Who may ask for the prompt. Both empty means whoever may approve: the
   * prompt says how the bot is set up, so by default it goes to the people
   * who already decide what the bot may do.
   */
  DISCORD_PROMPT_USER_IDS: csv,
  DISCORD_PROMPT_ROLE_IDS: csv,
  /** Where scheduled briefs are posted unless the schedule names a channel. */
  DISCORD_BRIEF_CHANNEL_ID: optionalString,
});

type CoreParsed = z.infer<typeof CoreSchema>;
type ProfileParsed = z.infer<typeof ProfileSchema>;

export interface CoreConfig extends CoreParsed {
  /** The bot's name, from its definition. */
  readonly botName: string;
  readonly sqlitePath: string;
}

export interface ProfileConfig extends Omit<ProfileParsed, "APPROVAL_LEVEL"> {
  /** `default`, or a name from BOT_PROFILES. Stored on every session and schedule. */
  readonly name: string;
  readonly APPROVAL_LEVEL: string;
  /** The shared working directory, absolute. */
  readonly workDir: string;
  /** Where posted files are saved, under the working directory. */
  readonly inboxDir: string;
}

/** The shared settings plus one profile's — what everything working on behalf of one profile takes. */
export type Config = CoreConfig & ProfileConfig;

export type DiscordConfig = z.infer<typeof DiscordSchema>;

/** Workspace-relative folder posted files are saved under. */
export const INBOX_DIR = "inbox";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** `PROFILE_<NAME>_` with the name upper-cased and dashes turned to underscores. */
export function profileEnvPrefix(name: string): string {
  return `PROFILE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
}

const unset = (v: string | undefined): boolean => v === undefined || v === "";

/**
 * The environment as the rest of this file reads it: older variable names
 * mapped onto current ones, and the bot's own defaults filled in. A variable
 * set under its current name always wins.
 */
export function effectiveEnv(
  def: Pick<BotDefinition, "envAliases" | "defaults">,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [legacy, current] of Object.entries(def.envAliases ?? {})) {
    if (unset(out[current]) && !unset(env[legacy])) out[current] = env[legacy];
    // The same alias, per profile: PROFILE_SAM_<legacy> → PROFILE_SAM_<current>.
    for (const key of Object.keys(env)) {
      if (!key.startsWith("PROFILE_") || !key.endsWith(`_${legacy}`)) continue;
      const mapped = `${key.slice(0, key.length - legacy.length)}${current}`;
      if (unset(out[mapped]) && !unset(env[key])) out[mapped] = env[key];
    }
  }
  for (const [key, value] of Object.entries(def.defaults ?? {})) {
    if (unset(out[key])) out[key] = value;
  }
  return out;
}

export function loadCore(def: BotDefinition, env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const parsed = CoreSchema.safeParse(effectiveEnv(def, env));
  if (!parsed.success) throw new ConfigError(`invalid configuration:\n${describe(parsed.error)}`);
  const c = parsed.data;
  return {
    ...c,
    botName: def.name,
    sqlitePath: c.SQLITE_PATH ?? join(c.DATA_DIR, `${def.name}.db`),
  };
}

export interface LoadedProfile<E = unknown> {
  readonly cfg: Config;
  /** The bot's own variables for this profile. */
  readonly env: E;
}

/**
 * Reads every profile. A per-profile variable wins over the plain one, so the
 * plain variables are the defaults shared by all profiles.
 */
export function loadProfiles<S extends z.ZodRawShape>(
  def: BotDefinition<S>,
  core: CoreConfig,
  rawEnv: NodeJS.ProcessEnv = process.env,
): LoadedProfile<z.infer<z.ZodObject<S>>>[] {
  const env = effectiveEnv(def, rawEnv);
  const names = (env.BOT_PROFILES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const list = names.length > 0 ? names : ["default"];
  const tiers = def.tiers ?? [];
  const levels = approvalLevels(tiers);
  const DomainSchema = z.object((def.env ?? {}) as S);

  const seen = new Set<string>();
  return list.map((name) => {
    if (!PROFILE_NAME.test(name)) {
      throw new ConfigError(`invalid configuration:\n  BOT_PROFILES: '${name}' — lowercase letters, digits and dashes only`);
    }
    if (seen.has(name)) throw new ConfigError(`invalid configuration:\n  BOT_PROFILES: '${name}' is listed twice`);
    seen.add(name);

    const prefix = names.length > 0 ? profileEnvPrefix(name) : null;
    const pick = (keys: readonly string[]): Record<string, string | undefined> => {
      const raw: Record<string, string | undefined> = {};
      for (const key of keys) {
        const own = prefix ? env[`${prefix}${key}`] : undefined;
        raw[key] = !unset(own) ? own : env[key];
      }
      return raw;
    };
    const where = name === "default" && names.length === 0 ? "" : ` for profile '${name}'`;

    const parsed = ProfileSchema.safeParse(pick(Object.keys(ProfileSchema.shape)));
    if (!parsed.success) throw new ConfigError(`invalid configuration${where}:\n${describe(parsed.error)}`);
    const p = parsed.data;

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: p.BOT_TIMEZONE });
    } catch {
      throw new ConfigError(`invalid configuration${where}:\n  BOT_TIMEZONE: '${p.BOT_TIMEZONE}' is not an IANA time zone`);
    }

    const level = p.APPROVAL_LEVEL ?? defaultApprovalLevel(tiers);
    if (!levels.includes(level)) {
      throw new ConfigError(
        `invalid configuration${where}:\n  APPROVAL_LEVEL: '${level}' — expected one of ${levels.join(", ")}`,
      );
    }

    const own = DomainSchema.safeParse(pick(Object.keys(DomainSchema.shape)));
    if (!own.success) throw new ConfigError(`invalid configuration${where}:\n${describe(own.error)}`);

    // The single unnamed profile keeps the directory a one-profile deployment
    // has always used; named profiles each get their own.
    const workDir =
      p.WORK_DIR ?? (names.length === 0 ? join(core.DATA_DIR, "workspace") : join(core.DATA_DIR, "profiles", name, "workspace"));

    const cfg: Config = {
      ...core,
      ...p,
      APPROVAL_LEVEL: level,
      name,
      workDir,
      inboxDir: join(workDir, INBOX_DIR),
    };
    return { cfg, env: own.data as z.infer<z.ZodObject<S>> };
  });
}

/** Which database to open, from the settings above. */
export function storeTarget(
  cfg: CoreConfig,
  onError?: (e: Error) => void,
):
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; url: string; schema?: string | undefined; poolMax: number; onError?: (e: Error) => void } {
  if (!cfg.DATABASE_URL) return { kind: "sqlite", path: cfg.sqlitePath };
  if (!/^postgres(ql)?:\/\//i.test(cfg.DATABASE_URL)) {
    throw new ConfigError("invalid configuration:\n  DATABASE_URL: only postgres:// URLs are supported — unset it to use SQLite");
  }
  return {
    kind: "postgres",
    url: cfg.DATABASE_URL,
    schema: cfg.DATABASE_SCHEMA,
    poolMax: cfg.DATABASE_POOL_MAX,
    ...(onError ? { onError } : {}),
  };
}

export function requireDiscord(env: NodeJS.ProcessEnv = process.env): DiscordConfig {
  const parsed = DiscordSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(`invalid Discord configuration:\n${describe(parsed.error)}`);
  return parsed.data;
}
