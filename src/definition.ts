import type { AgentBackend, McpServer, ToolDefinition } from "./agent/backend.js";
import type { z } from "zod";
import type { Config, CoreConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Phrasebook } from "./discord/activity.js";
import type { Session } from "./session/types.js";
import type { WorkspaceProvider } from "./workspace.js";

/**
 * What a bot is, to this library.
 *
 * discordllm owns everything that is the same for any bot of this shape:
 * Discord threads and their queue, the session and turn ledger, resuming
 * after a restart, the quota guard, schedules, polls, approval cards, and the
 * rules that keep the agent contained, whichever model is behind it.
 *
 * A bot supplies the rest, and only the rest: which MCP servers to run and
 * with what credentials, how risky each of their tools is, what the agent is
 * told about the place it is working in, and where it stands on disk.
 *
 * `BotDefinition` is static — it exists before any environment is read.
 * `Domain` is what `setup` builds from the environment, once per profile.
 */

/** One call the agent wants to make. */
export interface ToolCall {
  /** As the SDK names it: `Read`, or `mcp__<server>__<tool>`. */
  readonly toolName: string;
  /** The MCP server, or null for a Claude Code built-in. */
  readonly server: string | null;
  /** The name without its `mcp__<server>__` prefix. */
  readonly tool: string;
  readonly input: unknown;
}

/** Splits `mcp__homebox__get_item` into its server and tool. */
export function parseToolName(toolName: string): { server: string | null; tool: string } {
  if (!toolName.startsWith("mcp__")) return { server: null, tool: toolName };
  const rest = toolName.slice("mcp__".length);
  const cut = rest.indexOf("__");
  if (cut === -1) return { server: null, tool: toolName };
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

export function toolCall(toolName: string, input: unknown): ToolCall {
  return { toolName, ...parseToolName(toolName), input };
}

export interface Classification {
  /** One of the bot's `tiers`. */
  readonly tier: string;
  /** Why, in a phrase, for the approval card and the audit log. */
  readonly reason: string;
}

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export const ALLOW: Decision = { allow: true };
export const deny = (reason: string): Decision => ({ allow: false, reason });

export interface PolicyCall extends ToolCall {
  /** Absolute path of the directory the agent is standing in this turn. */
  readonly workDir: string;
  /** False for a scheduled run. */
  readonly interactive: boolean;
}

/** What is known when a turn is about to start. */
export interface TurnInfo {
  readonly session: Session;
  /** The agent's working directory for this turn. */
  readonly dir: string;
  /** True when this turn had to create the directory (a new or swept workspace). */
  readonly dirCreated: boolean;
  /** False for a scheduled run: nobody is there to approve or to ask. */
  readonly interactive: boolean;
  readonly actorId: string | null;
  readonly timeZone: string;
  /** The profile's approval level: one of the bot's tiers, or `none`. */
  readonly approvalLevel: string;
  /** The full name of one of the bot server's own tools, e.g. `mcp__bot__poll`. */
  readonly botTool: (name: string) => string;
}

/** Everything a bot contributes to one turn. Built fresh each turn. */
export interface DomainTurn {
  /** Appended to Claude Code's own system prompt. */
  readonly systemPrompt: string;
  /** Extra `- key: value` lines for the per-turn header, after the date. */
  readonly headerLines?: readonly string[];
  /** Extra tools on the bot's in-process server, alongside poll and schedules. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools?: readonly ToolDefinition<any>[];
}

/** One profile's side of a bot, built by `setup`. */
export interface Domain {
  /** The MCP servers the agent may use. With `strictMcpConfig` this is the whole list. */
  readonly servers: Readonly<Record<string, McpServer>>;
  /** Added to the agent subprocess's environment. Never put a server's token here. */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /** Where the agent stands. Defaults to one shared directory under DATA_DIR. */
  readonly workspace?: WorkspaceProvider;
  /**
   * Sorts a call into one of the bot's tiers. Return undefined for a call the
   * ladder does not apply to (a built-in, one of the bot's own tools). Must
   * fail toward asking: an unknown tool belongs in a tier that waits.
   */
  classify?(call: ToolCall): Classification | undefined;
  /** Extra synchronous rules, run after the library's own. A refusal is final. */
  policy?(call: PolicyCall): Decision;
  /** One line saying what a call will do, for the approval card. */
  describe?(call: ToolCall): string | undefined;
  /** Wording for the live progress message. */
  readonly phrasebook?: Phrasebook;
  /** The system prompt, and anything else that is decided per turn. */
  turn(info: TurnInfo): DomainTurn | Promise<DomainTurn>;
  /** Sentences added to a scheduled brief's prompt, e.g. that the run only looks. */
  readonly briefNote?: string;
  /** Extra state for one line of the `threads` report: a branch, what is unshipped. */
  threadLine?(session: Session): Promise<string | undefined>;
  /** Absolute directories whose new files are posted to the thread after a reply. */
  readonly postFilesFrom?: readonly string[];
  /** Fields for this profile's startup log line. No secrets. */
  readonly startup?: Readonly<Record<string, unknown>>;
  /** What to call the session's stored `branch`, when the workspace gives it one. */
  refFor?(session: { id: string; title: string; kind: "chat" | "brief" }): string;
}

export interface SetupContext<E> {
  /** Shared settings plus this profile's. */
  readonly cfg: Config;
  /** The bot's own variables, parsed with `env`, for this profile. */
  readonly env: E;
  readonly log: Logger;
  /** Whatever `prepare` returned. */
  readonly shared: unknown;
  /** The ledger, read-only: for housekeeping that has to know whose a directory is. */
  readonly sessions: { byId(id: string): Promise<Session | undefined> };
}

export interface BotDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** `homeboxcordllm`: the database file, the metrics prefix, the startup line. */
  readonly name: string;
  /**
   * The bot's own environment variables, as a Zod raw shape. Each can also be
   * set per profile as `PROFILE_<NAME>_<VARIABLE>`.
   */
  readonly env?: S;
  /** Older names for variables, still accepted: `{ BOX_APPROVAL_LEVEL: "APPROVAL_LEVEL" }`. */
  readonly envAliases?: Readonly<Record<string, string>>;
  /** Defaults for the library's own variables: `{ AGENT_MAX_TURNS: "80" }`. */
  readonly defaults?: Readonly<Record<string, string>>;
  /** Variables whose values must never reach a log line. */
  readonly secrets?: readonly string[];
  /**
   * The approval ladder, least to most dangerous. The first tier is "only
   * looks" and never waits. Omit for a bot with no approval step.
   */
  readonly tiers?: readonly string[];
  /** What each tier is called on an approval card. Defaults to its name, capitalised. */
  readonly tierLabels?: Readonly<Record<string, string>>;
  /**
   * Give the agent Bash. Off by default, and for a reason: a shell can read an
   * MCP server's token out of that server's environment. Only for a bot whose
   * job is working in a directory, and whose secrets are not on this machine.
   */
  readonly shell?: boolean;
  /** Load the working directory's own Claude Code skills. */
  readonly skills?: boolean;
  /** The in-process server's name. `bot` unless transcripts already use another. */
  readonly botServer?: string;
  /**
   * The model behind the bot. Defaults to Claude, through the Claude Agent SDK.
   * Anything that implements `AgentBackend` (agent/backend.ts) can stand in.
   */
  readonly backend?: AgentBackend;
  /** Save files posted in Discord into the workspace and show images to the model. */
  readonly attachments?: boolean;
  /** Runs once, before any profile is set up. Its result is `SetupContext.shared`. */
  prepare?(ctx: { readonly cfg: CoreConfig; readonly log: Logger }): Promise<unknown>;
  /** Builds one profile's domain. Throw to skip the profile with a logged reason. */
  setup(ctx: SetupContext<z.infer<z.ZodObject<S>>>): Domain | Promise<Domain>;
}

/** Identity, typed: lets a bot's `setup` see its own variables' types. */
export function defineBot<S extends z.ZodRawShape>(def: BotDefinition<S>): BotDefinition<S> {
  return def;
}
