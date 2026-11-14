import { describe, expect, it } from "vitest";
import { promptSummary, renderPromptReport, type PromptReport } from "./inspect.js";

const base: PromptReport = {
  bot: "boxbot",
  profile: "default",
  backend: "scripted",
  model: null,
  interactive: true,
  session: { id: "s1", title: "where is the drill", turns: 2 },
  workDir: "/data/workspace",
  tiers: ["read", "write", "destructive"],
  approvalLevel: "write",
  servers: ["box"],
  botTools: ["mcp__bot__poll"],
  builtinTools: ["Read", "Glob"],
  shell: false,
  skills: false,
  systemPrompt: "You look after a box.\n\n```json\n{}\n```",
  systemPromptHash: "abc123",
  header: "Context for this turn:\n- Now: today",
  last: null,
};

describe("the prompt report", () => {
  it("shows the system prompt whole, in a fence its own contents cannot close", () => {
    const md = renderPromptReport(base, "UTC");
    expect(md).toContain("# What boxbot is told");
    expect(md).toContain("````\nYou look after a box.\n\n```json\n{}\n```\n````");
    expect(md).toContain("level `write` (write, destructive wait)");
    expect(md).toContain("MCP servers: `box`");
    expect(md).not.toContain("Last turn");
  });

  it("says what it cannot show", () => {
    expect(renderPromptReport(base, "UTC")).toContain("Not shown: the backend's own base prompt");
  });

  it("includes the last turn, and its system prompt only when that differed", () => {
    const last = { seq: 2, status: "ok", trigger: "thread_message", startedAt: 0, prompt: "Sam says:\n\nhello" };
    const same = renderPromptReport({ ...base, last: { ...last, sameSystemPrompt: true, systemPrompt: null } }, "UTC");
    expect(same).toContain("## Last turn in this thread (#2, thread_message, ok,");
    expect(same).toContain("It ran with the system prompt above.");
    expect(same).not.toContain("Its system prompt:");

    const differs = renderPromptReport({ ...base, last: { ...last, sameSystemPrompt: false, systemPrompt: "Old words." } }, "UTC");
    expect(differs).toContain("Its system prompt:\n\n```\nOld words.\n```");

    const unknown = renderPromptReport({ ...base, last: { ...last, sameSystemPrompt: null, systemPrompt: null } }, "UTC");
    expect(unknown).toContain("was not recorded");
  });

  it("handles a bot with no ladder and an empty prompt", () => {
    const md = renderPromptReport({ ...base, tiers: [], approvalLevel: "none", systemPrompt: "", session: null }, "UTC");
    expect(md).toContain("Approval: no ladder");
    expect(md).toContain("_Empty:");
    expect(md).toContain("the first turn of a new conversation");
  });

  it("summarises in one line for the Discord message", () => {
    expect(promptSummary(base)).toBe("System prompt `abc123`, 37 characters, for this thread's next turn.");
    expect(promptSummary({ ...base, last: { seq: 1, status: "ok", trigger: "mention", startedAt: 0, prompt: "", sameSystemPrompt: false, systemPrompt: "x" } })).toContain(
      "changed since",
    );
  });
});
