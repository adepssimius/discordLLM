import { createSdkMcpServer, tool as sdkTool, type CanUseTool, type HookCallback, type HookInput, type McpServerConfig, type Options, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRun, ToolGuard } from "../../agent/backend.js";
import { SHELL_TOOLS } from "../../agent/policy.js";
import { agentEnv } from "./env.js";

/**
 * Turns a neutral `AgentRun` into Claude Agent SDK `Options`. Every `Options`
 * object in this process comes from `buildOptions`.
 *
 * The run says what exists and hands over a guard. These are the fields that
 * make the SDK honour it, and options.test.ts pins them:
 *
 *  - `cwd` is the working directory, and the guard keeps file tools inside it;
 *  - `env` is a short allowlist with no Discord token and no MCP server's
 *    token in it;
 *  - `strictMcpConfig` means the only MCP servers are the ones passed here, so
 *    a `.mcp.json` in the working directory cannot add one;
 *  - `settingSources` is the project alone, never the user level — on a
 *    persistent volume that is a file an earlier run could have written;
 *  - `allowedTools` is empty, so nothing is approved before `canUseTool` is
 *    asked, which is where a change waits for a person.
 */

/**
 * Subagents run outside the guard, WebFetch makes requests from inside the pod
 * network to wherever the model points it, and there are no notebooks.
 */
export const ALWAYS_DENY = ["Task", "Agent", "WebFetch", "NotebookEdit"] as const;

/** The built-ins a bot never gets — plus the shell, unless it was defined with one. */
export function builtinDeny(shell: boolean): string[] {
  return shell ? [...ALWAYS_DENY] : [...ALWAYS_DENY, ...SHELL_TOOLS.filter((t) => t !== "KillBash")];
}

/**
 * PreToolUse hook.
 *
 * This runs before deny rules, the permission mode, and allow rules, so it is
 * the one place that sees every tool call. Registered with no `matcher`: a
 * matcher-less hook runs for every event of its type.
 *
 * It answers from the guard's synchronous half. A hook cannot wait for a
 * person — hooks time out — so a call that needs one is answered `ask`, which
 * forces it through the permission prompt even if Claude Code would otherwise
 * have let the tool through on its own (an MCP tool annotated read-only, a
 * future default). The prompt is `canUseTool`, below.
 */
export function createGate(guard: ToolGuard): HookCallback {
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const r = guard.check(pre.tool_name, pre.tool_input);

    if (!r.decision.allow) {
      return {
        systemMessage: `Blocked: ${r.decision.reason}`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: r.decision.reason,
        },
      };
    }
    if (r.needsApproval) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "ask" as const,
          permissionDecisionReason: `needs approval: ${r.why ?? "the bot's rules"}`,
        },
      };
    }
    return {};
  };
}

/**
 * Answers Claude Code's permission prompts, from the guard.
 *
 * With `allowedTools` empty, every call that is not a plain read of the
 * working directory lands here — which makes this the place a change can wait
 * for a person, for as long as it takes.
 *
 * It is also what says yes where Claude Code would otherwise ask someone at a
 * keyboard: edits under `.claude/`, `.mcp.json` and the like are "sensitive"
 * to Claude Code whatever an allow rule says, and with nobody to ask they
 * would simply be refused.
 */
export function answerPrompt(guard: ToolGuard): CanUseTool {
  return async (toolName, input, opts) => {
    const flagged = opts.decisionReason ?? opts.blockedPath;
    const a = await guard.authorize(toolName, input, { signal: opts.signal, toolUseId: opts.toolUseID, flagged });
    return a.allow
      ? { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID }
      : { behavior: "deny", message: a.message ?? "refused", toolUseID: opts.toolUseID };
  };
}

export function buildOptions(run: AgentRun, env: NodeJS.ProcessEnv = process.env): Options {
  if (run.resume && run.sessionId) {
    throw new Error("buildOptions: `resume` and `sessionId` are mutually exclusive");
  }

  const deny = builtinDeny(run.shell);
  const denied = new Set<string>(deny);
  const builtins = run.builtinTools.filter((t) => !denied.has(t));

  // The in-process tools, as one SDK server under the name the bot chose.
  const own = createSdkMcpServer({
    name: run.toolServer,
    version: "0.1.0",
    tools: run.tools.map((t) =>
      sdkTool(t.name, t.description, t.inputSchema, t.handler as never, t.annotations ? { annotations: t.annotations } : {}),
    ),
  });

  return {
    ...(run.model ? { model: run.model } : {}),
    cwd: run.workDir,
    systemPrompt: { type: "preset", preset: "claude_code", append: run.systemPrompt },
    // Project only: the working directory's CLAUDE.md is the bot's notes (or
    // the repository's own instructions). Never `user`.
    settingSources: ["project"],
    ...(run.skills ? { skills: "all" as const } : {}),
    strictMcpConfig: true,
    // `default`, not `dontAsk`: what would be a prompt goes to canUseTool,
    // which is where approvals happen.
    permissionMode: "default",
    canUseTool: answerPrompt(run.guard),

    // What the agent can call is decided by what exists: the built-ins named
    // here and the tools of the servers below. allowedTools stays empty on
    // purpose — any entry there approves its tool before canUseTool is asked,
    // which for a gated tool would skip the approval step entirely.
    tools: [...builtins],
    disallowedTools: [...deny],
    allowedTools: [],

    mcpServers: { ...(run.servers as Record<string, McpServerConfig>), [run.toolServer]: own },

    hooks: { PreToolUse: [{ hooks: [createGate(run.guard)] }] },

    maxTurns: run.maxTurns,
    env: agentEnv({ timeZone: run.timeZone, extra: run.env }, env),
    ...(run.resume ? { resume: run.resume } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  };
}
