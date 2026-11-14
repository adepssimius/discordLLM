import { describe, expect, it } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { box, rules, silentLog as log } from "../../../test/kit.js";
import { tool, type AgentRun } from "../../agent/backend.js";
import { createGuard } from "../../agent/guard.js";
import type { Approver } from "../../agent/approval.js";
import { ALWAYS_DENY, answerPrompt, buildOptions, builtinDeny, createGate } from "./options.js";

const signal = new AbortController().signal;
const DEL = box("delete_item");
const MOVE = box("move_item");

const guardWith = (o: { interactive?: boolean; approver?: Approver } = {}) =>
  createGuard({ log, rules, workDir: "/data/workspace", interactive: o.interactive ?? true, approvalLevel: "destructive", approver: o.approver });

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  workDir: "/data/workspace",
  systemPrompt: "be useful",
  prompt: { text: "hi" },
  sessionId: "00000000-0000-4000-8000-000000000000",
  title: "t",
  servers: { box: { type: "stdio", command: "box-mcp", env: { BOX_TOKEN: "box-secret" } } },
  toolServer: "bot",
  tools: [tool("poll", "Ask.", { key: z.string() }, async () => ({ content: [{ type: "text", text: "ok" }] }))],
  builtinTools: ["Read", "Write", "Bash", "Task"],
  shell: false,
  skills: false,
  guard: guardWith(),
  env: {},
  timeZone: "UTC",
  maxTurns: 10,
  shouldStop: () => false,
  ...over,
});

describe("the hook and the prompt, driven by the guard", () => {
  const pre = (tool_name: string, tool_input: unknown): HookInput =>
    ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "" }) as unknown as HookInput;

  it("answers `ask` for a call that needs approval, so canUseTool cannot be skipped", async () => {
    const out = await createGate(guardWith())(pre(DEL, {}), "t1", { signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("stays out of the way of reads and ordinary edits", async () => {
    expect(await createGate(guardWith())(pre(MOVE, {}), "t1", { signal })).toEqual({});
    expect(await createGate(guardWith())(pre(box("search_items"), {}), "t1", { signal })).toEqual({});
  });

  it("denies outright in a scheduled run, and what the bot's own rules refuse", async () => {
    expect(await createGate(guardWith({ interactive: false }))(pre(MOVE, {}), "t1", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(await createGate(guardWith())(pre(box("attach_document"), { source: "/proc/self/environ" }), "t1", { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("waits for the approver in canUseTool and passes its answer on", async () => {
    const prompt = { signal, toolUseID: "t1", requestId: "r1" };
    const yes = answerPrompt(guardWith({ approver: async () => ({ approved: true, by: "u1" }) }));
    expect(await yes(DEL, { a: 1 }, prompt)).toMatchObject({ behavior: "allow", updatedInput: { a: 1 } });
    const nobody = answerPrompt(guardWith());
    expect(await nobody(DEL, {}, prompt)).toMatchObject({ behavior: "deny", message: expect.stringContaining("nobody here") });
  });
});

/** The fields that keep the agent contained. A run cannot change them, except the shell, by its one flag. */
describe("buildOptions", () => {
  const opts = buildOptions(run(), { PATH: "/bin", DISCORD_BOT_TOKEN: "discord-secret", BOX_TOKEN: "box-secret" });

  it("routes prompts to canUseTool, where approvals happen", () => {
    // bypassPermissions would skip canUseTool — and every approval with it.
    expect(opts.permissionMode).toBe("default");
    expect(opts.canUseTool).toBeTypeOf("function");
  });

  it("keeps the allow list empty, so no tool is pre-approved", () => {
    expect(opts.allowedTools).toEqual([]);
  });

  it("removes subagents, WebFetch and the shell outright", () => {
    expect(opts.disallowedTools).toEqual(builtinDeny(false));
    expect(opts.tools).toEqual(["Read", "Write"]);
    for (const t of [...ALWAYS_DENY, "Bash", "BashOutput", "KillShell"]) expect(opts.disallowedTools).toContain(t);
  });

  it("gives a shell only to a run that has one, and still no subagents", () => {
    const shell = buildOptions(run({ shell: true }));
    expect(shell.tools).toEqual(["Read", "Write", "Bash"]);
    expect(shell.disallowedTools).toEqual([...ALWAYS_DENY]);
  });

  it("works in the workspace and loads only the run's MCP servers and project settings", () => {
    expect(opts.cwd).toBe("/data/workspace");
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.settingSources).toEqual(["project"]);
    expect(Object.keys(opts.mcpServers ?? {}).sort()).toEqual(["bot", "box"]);
  });

  it("serves the in-process tools under the name the bot chose", () => {
    expect(Object.keys(buildOptions(run({ toolServer: "fitcord" })).mcpServers ?? {})).toContain("fitcord");
  });

  it("registers the gate for every tool call", () => {
    const pre = opts.hooks?.PreToolUse ?? [];
    expect(pre).toHaveLength(1);
    expect(pre[0]?.matcher).toBeUndefined();
  });

  it("refuses to both resume and start a session", () => {
    expect(() => buildOptions(run({ resume: "a" }))).toThrow();
    expect(buildOptions(run({ resume: "a", sessionId: undefined })).resume).toBe("a");
  });

  it("puts a server's token in that server's environment and not in the agent's", () => {
    expect(JSON.stringify(opts.env)).not.toContain("box-secret");
    expect(JSON.stringify(opts.env)).not.toContain("discord-secret");
    expect(JSON.stringify(opts.mcpServers?.box)).toContain("box-secret");
  });

  it("appends the bot's instructions to Claude Code's own", () => {
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "be useful" });
  });
});
