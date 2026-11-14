import { readFileSync } from "node:fs";
import type { McpServer } from "./agent/backend.js";
import { z } from "zod";
import { ConfigError, profileEnvPrefix } from "./config.js";
import { defineBot, type BotDefinition, type Domain } from "./definition.js";
import { classifyByName, DEFAULT_TIERS } from "./agent/tiers.js";
import { sections } from "./agent/prompts.js";
import { NOTES_FILE, sharedWorkspace } from "./workspace.js";

/**
 * A bot from a file, with no code: name the MCP servers, say a sentence about
 * what the bot is for, and it runs — threads, schedules, polls, and approval
 * on the default `read / write / destructive` ladder, sorted by tool name.
 *
 *   {
 *     "name": "boxbot",
 *     "about": "You help look after a household inventory kept in Homebox.",
 *     "servers": {
 *       "homebox": {
 *         "command": "homebox-mcp",
 *         "env": { "HOMEBOX_URL": "${HOMEBOX_URL}", "HOMEBOX_TOKEN": "${HOMEBOX_TOKEN}" }
 *       }
 *     },
 *     "tools": { "read": ["inventory_stats"], "destructive": ["import_csv"] }
 *   }
 *
 * `${NAME}` is read from the environment when the bot starts (per profile, if
 * `PROFILE_<P>_NAME` is set), so the file holds no secrets and can be
 * committed. A server that refers to a variable that is not set is left out,
 * with a logged reason, rather than started half-configured.
 *
 * This is the floor, not the ceiling. A bot whose tools take an `action`
 * argument, or that needs its own rules, tools or workspace, is a
 * `defineBot` in TypeScript.
 */

const Server = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    url: z.string().min(1),
    transport: z.enum(["http", "sse"]).default("http"),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);

export const BotFileSchema = z.object({
  /** Lowercase; names the database file and the metrics. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** A sentence or two on what the bot is for, in the second person. */
  about: z.string().min(1),
  servers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), Server).default({}),
  /** Corrections to sorting tools by name. Bare tool names. */
  tools: z
    .object({
      read: z.array(z.string()).default([]),
      destructive: z.array(z.string()).default([]),
    })
    .default({ read: [], destructive: [] }),
  /** The notes the agent keeps in its working directory. */
  notes: z
    .object({
      subject: z.string().default("working"),
      seed: z.string().optional(),
    })
    .default({ subject: "working" }),
  /** Take files posted in Discord. Needs the `sharp` package to show images inline. */
  attachments: z.boolean().default(false),
  /** Environment variables whose values must never be logged, beyond the ones `${…}` names. */
  secrets: z.array(z.string()).default([]),
});

export type BotFile = z.infer<typeof BotFileSchema>;

const REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function refsIn(value: unknown, out: Set<string>): void {
  if (typeof value === "string") for (const m of value.matchAll(REF)) out.add(m[1]!);
  else if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) refsIn(v, out);
}

export function loadBotFile(path: string): BotFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read the bot file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = BotFileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`invalid bot file ${path}:\n${lines}`);
  }
  return parsed.data;
}

/** Turns a bot file into a definition. `env` is injectable for tests. */
export function configBot(file: BotFile, env: NodeJS.ProcessEnv = process.env): BotDefinition {
  const referenced = new Set<string>();
  refsIn(file.servers, referenced);

  return defineBot({
    name: file.name,
    tiers: DEFAULT_TIERS,
    attachments: file.attachments,
    secrets: [...referenced, ...file.secrets],

    setup({ cfg, log }): Domain {
      const prefix = cfg.name === "default" ? null : profileEnvPrefix(cfg.name);
      const lookup = (name: string): string | undefined => {
        const own = prefix ? env[`${prefix}${name}`] : undefined;
        const v = own !== undefined && own !== "" ? own : env[name];
        return v === undefined || v === "" ? undefined : v;
      };
      /** Undefined when a variable the string names is not set. */
      const fill = (s: string, missing: Set<string>): string =>
        s.replace(REF, (_m, name: string) => {
          const v = lookup(name);
          if (v === undefined) missing.add(name);
          return v ?? "";
        });
      const fillAll = (o: Record<string, string>, missing: Set<string>): Record<string, string> =>
        Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v, missing)]));

      const servers: Record<string, McpServer> = {};
      for (const [name, s] of Object.entries(file.servers)) {
        const missing = new Set<string>();
        const built: McpServer =
          "command" in s
            ? {
                type: "stdio",
                command: fill(s.command, missing),
                args: s.args.map((a) => fill(a, missing)),
                env: {
                  ...fillAll(s.env, missing),
                  PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                  HOME: env.HOME ?? "/tmp",
                },
              }
            : { type: s.transport, url: fill(s.url, missing), headers: fillAll(s.headers, missing) };
        if (missing.size > 0) {
          log.error({ server: name, unset: [...missing] }, "an MCP server needs variables that are not set — its tools are disabled");
          continue;
        }
        servers[name] = built;
      }

      const connected = Object.keys(servers);
      const workspace = sharedWorkspace({
        dir: cfg.workDir,
        notesSeed:
          file.notes.seed ??
          `# ${file.notes.subject.charAt(0).toUpperCase()}${file.notes.subject.slice(1)} notes\n\nKept by ${file.name}. Loaded into every conversation. Short, current, no secrets.\n`,
      });

      return {
        servers,
        workspace,
        classify: classifyByName(Object.keys(file.servers), file.tools),
        startup: { workspace: cfg.workDir },
        async turn(info) {
          await workspace.init();
          const where = `## Where you are running

You are being reached through Discord by ${file.name}, a self-hosted bot. ${file.about}
There is no terminal and no IDE on the other end: a person is reading your reply in a Discord thread,
usually on a phone. Each thread is its own conversation and survives restarts of the bot.`;

          const tools =
            connected.length > 0
              ? `## Tools

${connected.map((s) => `\`mcp__${s}__*\``).join(", ")} ${connected.length === 1 ? "is" : "are"} how you act. Calls are real and immediate.
Find before you act: look something up rather than guessing its name, and say which you mean when
several things match. After a change, say what changed in a line.

${sections.approval(sections.approvalSummary(DEFAULT_TIERS, info.approvalLevel))}`
              : `## Tools

No MCP servers are connected in this run. If a request needs one, say so plainly rather than guessing.`;

          const ctx = { botTool: info.botTool, timeZone: info.timeZone };
          return {
            systemPrompt: [
              where,
              tools,
              ...(file.attachments ? [sections.attachments({ inboxDir: "inbox" })] : []),
              sections.notes({ file: NOTES_FILE, subject: file.notes.subject }),
              sections.schedules({ ...ctx, scheduledRun: "A scheduled run only looks: it cannot change anything." }),
              sections.polls(ctx),
              sections.formatting(),
            ].join("\n\n"),
          };
        },
      };
    },
  });
}
