import type { z } from "zod";
import type { Decision } from "../definition.js";
import type { ImageBlock } from "./images.js";

/**
 * The seam between this library and the model.
 *
 * Everything on the Discord side — threads, the ledger, approvals, schedules,
 * polls, profiles, the quota guard — talks to an `AgentBackend` and nothing
 * else. The default backend is Claude, through the Claude Agent SDK
 * (backends/claude). Another model is another implementation of this file's
 * interface, passed as `defineBot({ backend })`; nothing outside the backend's
 * own directory imports a model SDK, and a test keeps it that way.
 *
 * What a backend is handed for a turn is a complete, neutral description of
 * the run: where to stand, what to say, which MCP servers and in-process
 * tools exist, and a `guard` to put every tool call through. What it owes back
 * is the outcome and a running commentary through the sink.
 *
 * The contract a backend must keep, because the rest of the library's safety
 * rests on it:
 *
 *  1. **Every tool call goes through `guard.authorize` before it runs**, and a
 *     refusal means the call does not happen. `authorize` may take minutes — a
 *     person is finding their phone. `guard.check` is the same decision
 *     without the waiting, for a backend that has a synchronous hook to answer.
 *  2. **Only the tools described here exist.** `servers`, `tools` and
 *     `builtinTools` are the whole surface. No shell unless `shell` is true.
 *  3. **Built-in tools use the library's vocabulary**: `Read`, `Glob`, `Grep`
 *     to look at files; `Write`, `Edit` to change them; `Bash` for a shell.
 *     The file-confinement rules (agent/policy.ts) recognise calls by these
 *     names and by a `file_path` (or `path`) argument. A backend whose own
 *     file tools are called something else maps them onto these before asking
 *     the guard.
 *  4. **The model's own process, if there is one, gets `env` and nothing
 *     else** of this process's environment, beyond its own credentials.
 *  5. **A conversation id that `canResume` accepts continues the same
 *     conversation**, in the same `workDir`, across restarts of this process.
 */

/** An MCP server the agent may use. A server's token belongs in its own `env` or `headers`. */
export type McpServer =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: string[];
      readonly env?: Record<string, string>;
    }
  | { readonly type: "http" | "sse"; readonly url: string; readonly headers?: Record<string, string> };

/** What an in-process tool hands back. The same shape MCP uses. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** A tool served in-process: by this library (polls, schedules) or by the bot. */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  /** The arguments, as a Zod raw shape — `{ message: z.string() }`, not `z.object(...)`. */
  readonly inputSchema: S;
  readonly handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
}

/** Defines an in-process tool. Whichever model is behind the bot, the tool is written once. */
export function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  extras: { readonly annotations?: ToolDefinition["annotations"] } = {},
): ToolDefinition<S> {
  return { name, description, inputSchema, handler, ...(extras.annotations ? { annotations: extras.annotations } : {}) };
}

/** Limit telemetry from the provider, when it offers any. Feeds the quota guard. */
export interface RateLimitInfo {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  /** Which of the provider's limits this is about, in its own words. */
  readonly rateLimitType?: string | undefined;
  /** Seconds since the epoch. */
  readonly resetsAt?: number | undefined;
  /** 0–1. */
  readonly utilization?: number | undefined;
}

export interface AgentSink {
  onSession?(conversationId: string): void;
  /** One block of the reply. Blocks are whole paragraphs, in order, not a stream of fragments. */
  onText?(text: string): void;
  onToolUse?(name: string, input: unknown, id: string): void;
  /** A plain-language summary of a group of tool calls, when the backend can produce one. */
  onToolSummary?(summary: string, toolUseIds: readonly string[]): void;
  onThinking?(): void;
  onRateLimit?(info: RateLimitInfo): void;
}

interface Usage {
  /**
   * Model round trips consumed. The currency the hourly budget is
   * denominated in, so report it on failures too: a run that dies after forty
   * steps is the most expensive thing this system does.
   */
  readonly numTurns: number;
  readonly costUsd: number;
}

export type AgentOutcome =
  | ({ readonly ok: true; readonly sessionId: string | undefined; readonly result: string } & Usage)
  | ({
      readonly ok: false;
      readonly sessionId: string | undefined;
      /** A machine-readable kind, when the backend has one. `error_max_turns` is recognised. */
      readonly subtype?: string;
      readonly error: string;
      readonly exhaustedTurns: boolean;
      readonly rateLimit?: RateLimitInfo;
    } & Usage);

export interface Authorization {
  readonly allow: boolean;
  /** Present when refused: what to tell the model. */
  readonly message?: string;
}

/** What stands between the model and every tool. Built by the library; called by the backend. */
export interface ToolGuard {
  /**
   * The synchronous half: the policy alone. `needsApproval` says the call is
   * allowed so far but must still go through `authorize`.
   */
  check(toolName: string, input: unknown): { readonly decision: Decision; readonly needsApproval: boolean; readonly why?: string };
  /** The whole decision. Waits for a person when the call needs one. Never rejects. */
  authorize(
    toolName: string,
    input: unknown,
    o: { readonly signal: AbortSignal; readonly toolUseId: string; readonly flagged?: string | undefined },
  ): Promise<Authorization>;
}

export interface AgentRun {
  /** The agent's working directory. The same path on every turn of a conversation. */
  readonly workDir: string;
  /** The bot's instructions, in addition to whatever the backend tells its model by itself. */
  readonly systemPrompt: string;
  readonly prompt: { readonly text: string; readonly images?: readonly ImageBlock[] };
  /** Continue this conversation… */
  readonly resume?: string | undefined;
  /** …or start one under this id. Exactly one of the two is set. */
  readonly sessionId?: string | undefined;
  /** What to call the conversation, for a backend that keeps titles. */
  readonly title: string;

  readonly servers: Readonly<Record<string, McpServer>>;
  /** The in-process tools, and the server name they appear under: `mcp__<toolServer>__<name>`. */
  readonly toolServer: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools: readonly ToolDefinition<any>[];
  /** Built-in tools the agent may use, in the library's vocabulary. */
  readonly builtinTools: readonly string[];
  readonly shell: boolean;
  /** Load the working directory's own skills, for a backend that has such a thing. */
  readonly skills: boolean;

  readonly guard: ToolGuard;
  /** Extra environment for the model's process. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeZone: string;
  /** Unset means the backend's default. */
  readonly model?: string | undefined;
  readonly maxTurns: number;
  /** Consulted between steps: a `stop` in Discord ends the run. */
  readonly shouldStop: () => boolean;
}

export interface AgentBackend {
  /** For the startup log: `claude-agent-sdk`. */
  readonly name: string;
  /**
   * Whether the backend can run at all, from the environment. `source` goes in
   * the startup log; `problem` is shown and the bot does not start.
   */
  ready(env: NodeJS.ProcessEnv): { readonly ok: true; readonly source: string; readonly warning?: string } | { readonly ok: false; readonly problem: string };
  /** Environment variables holding this backend's credentials, so they never reach a log line. */
  readonly secrets: readonly string[];
  /** Whether a stored conversation is still there to continue. Must not throw. */
  canResume(conversationId: string, workDir: string): Promise<boolean>;
  /** Runs one turn to completion. Must not throw: a failure is an outcome. */
  run(run: AgentRun, sink: AgentSink): Promise<AgentOutcome>;
}
