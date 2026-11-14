import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ALLOW, deny, toolCall, type Classification, type Decision, type PolicyCall, type ToolCall } from "../definition.js";
import { isReadTier } from "./tiers.js";

/**
 * The synchronous gate on tool calls. Pure, so every rule is unit tested.
 *
 * The rules that hold for any bot:
 *
 *  - a stopped run makes no further calls;
 *  - there is no shell unless the bot was defined with one;
 *  - the file tools stay inside the working directory (and the scratch
 *    directory) — away from the volume's database, other processes' files
 *    under /proc, and anything else on the machine;
 *  - a scheduled run only looks. Nobody is there to approve a change, so it is
 *    refused every classified call above the first tier, whatever the
 *    approval level says.
 *
 * The bot's own rules (`Domain.policy`) run after these and can only refuse
 * more.
 *
 * Whether an interactive change goes ahead is not decided here. That waits
 * for a person (agent/options.ts `answerPrompt`), which a synchronous hook
 * cannot do.
 */

export interface PolicyRules {
  /** The bot's ladder; empty when it has none. */
  readonly tiers: readonly string[];
  /** True for a bot defined with `shell`. */
  readonly shell: boolean;
  /**
   * Whether Read, Glob and Grep are held to the working directory. On for a
   * bot without a shell; pointless for one with, which can `cat` anything.
   */
  readonly confineReads: boolean;
  readonly classify?: ((call: ToolCall) => Classification | undefined) | undefined;
  readonly policy?: ((call: PolicyCall) => Decision) | undefined;
}

export interface PolicyInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Absolute path of the agent's working directory this turn. */
  readonly workDir: string;
  /** False for a scheduled run. */
  readonly interactive: boolean;
  readonly aborted?: boolean;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
export const SHELL_TOOLS = ["Bash", "BashOutput", "KillShell", "KillBash"] as const;
const SHELL = new Set<string>(SHELL_TOOLS);

export function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function fieldString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Whether a path, as a tool was given it, lands in the working directory or
 * the scratch directory. `~` is never confined: something downstream (a
 * Python MCP server's expanduser) may expand it to somewhere else.
 */
export function confined(raw: string, workDir: string): boolean {
  if (raw.trim().startsWith("~")) return false;
  const target = resolve(workDir, raw);
  return inside(workDir, target) || inside(resolve(tmpdir()), target);
}

export function evaluate(rules: PolicyRules, i: PolicyInput): Decision {
  if (i.aborted) return deny("this run was stopped from Discord");

  if (!rules.shell && SHELL.has(i.toolName)) return deny("there is no shell here — use the tools you were given");

  if (WRITE_TOOLS.has(i.toolName)) {
    const raw = fieldString(i.toolInput, "file_path") ?? fieldString(i.toolInput, "notebook_path");
    if (!raw) return deny(`${i.toolName} was called without a file path`);
    if (!confined(raw, i.workDir)) return deny(`'${raw}' is outside the working directory — files stay inside ${i.workDir}`);
  } else if (rules.confineReads && READ_TOOLS.has(i.toolName)) {
    // Glob and Grep default to the working directory when no path is given.
    const raw = fieldString(i.toolInput, "file_path") ?? fieldString(i.toolInput, "path");
    if (raw && !confined(raw, i.workDir)) {
      return deny(`'${raw}' is outside the working directory — only ${i.workDir} is readable`);
    }
  }

  const call = toolCall(i.toolName, i.toolInput);

  if (!i.interactive && rules.classify) {
    const c = rules.classify(call);
    if (c && !isReadTier(rules.tiers, c.tier)) {
      return deny(
        `a scheduled run only looks — ${c.reason}. Say in the brief what you would change, ` +
          "and the person can ask for it from the thread",
      );
    }
  }

  return rules.policy ? rules.policy({ ...call, workDir: i.workDir, interactive: i.interactive }) : ALLOW;
}

/**
 * Argument names that look like a local path. For a bot whose MCP server
 * reads or writes local files on the agent's behalf: checking every argument
 * that is named like a path confines a tool a newer server version added
 * before anyone remembers to list it.
 */
export const PATHLIKE_KEY = /(^|_)(path|source|dir|file|filename|save_to|dest|destination)$/i;

/**
 * Holds an MCP tool's path-valued arguments to the working directory, exactly
 * like the agent's own file tools. Without it, a tool that uploads a local
 * path can be pointed at `/proc/self/environ`.
 */
export function confinePathArgs(
  call: PolicyCall,
  opts: { readonly known?: readonly string[]; readonly allowUrlIn?: readonly string[] } = {},
): Decision {
  const input = call.input !== null && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const keys = new Set([...(opts.known ?? []), ...Object.keys(input).filter((k) => PATHLIKE_KEY.test(k))]);
  for (const key of keys) {
    const raw = fieldString(call.input, key);
    if (raw === undefined || raw.trim() === "") continue;
    if (opts.allowUrlIn?.includes(key) && /^https?:\/\//i.test(raw.trim())) continue;
    if (!confined(raw, call.workDir)) {
      return deny(`${call.tool}: '${raw}' is outside the working directory — local files stay inside ${call.workDir}`);
    }
  }
  return ALLOW;
}

/** Exposed for tests: the directory separator makes path fixtures platform-shaped. */
export const PATH_SEP = sep;
