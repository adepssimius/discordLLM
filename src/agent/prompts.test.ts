import { describe, expect, it } from "vitest";
import { botToolNames } from "../tools/bot.js";
import {
  BRIEF_ONLY_LOOKS,
  briefUserPrompt,
  chatUserPrompt,
  localStamp,
  pollAnswerContent,
  stripTurnHeader,
  sections,
  turnHeader,
} from "./prompts.js";

const turn = { now: new Date("2026-10-02T10:31:00Z"), timeZone: "America/New_York" };
const ctx = { botTool: (n: string) => `mcp__bot__${n}`, timeZone: "America/New_York" };

describe("sections", () => {
  it("explain that the approval button is the question", () => {
    const s = sections.approval(sections.approvalSummary(["read", "write", "destructive"], "destructive"));
    expect(s).toMatch(/the button is the question/);
    expect(s).toMatch(/Do not retry it, and do not reach the\s+same result another way/);
  });

  it("describe each approval level differently", () => {
    const tiers = ["read", "write", "destructive"];
    const texts = ["write", "destructive", "none"].map((l) => sections.approvalSummary(tiers, l));
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toMatch(/write or destructive/);
  });

  it("tell the agent to keep secrets out of the notes", () => {
    expect(sections.notes({ file: "CLAUDE.md", subject: "inventory" })).toMatch(/Never write a token, password or other secret/);
  });

  it("only name bot tools that exist", () => {
    const text = [sections.schedules(ctx), sections.polls(ctx)].join("\n");
    const named = [...text.matchAll(/`(mcp__bot__\w+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const real = new Set(botToolNames("bot", true));
    for (const n of named) expect(real.has(n)).toBe(true);
  });
});

describe("turn header", () => {
  it("states the local time", () => {
    expect(turnHeader(turn)).toContain("Friday 2026-10-02 06:31 (America/New_York)");
  });

  it("carries the bot's own lines, and strips them again with the rest", () => {
    const t = { ...turn, extraLines: ["- Branch: fit/x (base: main)"] };
    expect(turnHeader(t)).toContain("- Branch: fit/x (base: main)");
    expect(stripTurnHeader(chatUserPrompt({ authorDisplayName: "Sam", content: "hi" }, t))).toBe("Sam says:\n\nhi");
  });

  it("does not open with a tag, or the SDK will not list the session for resume", () => {
    expect(chatUserPrompt({ authorDisplayName: "Sam", content: "hi" }, turn).charAt(0)).not.toBe("<");
    expect(briefUserPrompt({ name: "x", prompt: "y" }, turn).charAt(0)).not.toBe("<");
  });

  it("is stripped back out of a stored prompt", () => {
    const p = chatUserPrompt({ authorDisplayName: "Sam", content: "where is the drill?" }, turn);
    expect(stripTurnHeader(p)).toBe("Sam says:\n\nwhere is the drill?");
  });
});

describe("chatUserPrompt", () => {
  it("includes messages that arrived while the last run was going", () => {
    const p = chatUserPrompt({ authorDisplayName: "Sam", content: "turn off the porch", coalescedWith: ["and the hall"] }, turn);
    expect(p).toMatch(/They then added, before you replied:\n\nand the hall/);
  });
});

describe("posted files", () => {
  const files = [
    { path: "inbox/s/1-1-drill.jpg", name: "drill.jpg", contentType: "image/jpeg", bytes: 2_400_000, image: true },
    { path: "inbox/s/1-2-IMG_9.HEIC", name: "IMG_9.HEIC", contentType: "image/heic", bytes: 900_000, image: true },
    { path: "inbox/s/1-3-manual.pdf", name: "manual.pdf", contentType: "application/pdf", bytes: 40_000, image: false },
  ];

  it("lists each file with its path and whether it is already visible", () => {
    const p = chatUserPrompt(
      { authorDisplayName: "Sam", content: "add this", files, shown: new Set(["inbox/s/1-1-drill.jpg"]) },
      turn,
    );
    expect(p).toContain("`inbox/s/1-1-drill.jpg` — “drill.jpg”, image/jpeg, 2.3 MB; shown below as image 1");
    expect(p).toMatch(/1-2-IMG_9\.HEIC.*not shown — Read it/);
    expect(p).toMatch(/1-3-manual\.pdf.*Read it if you need its contents/);
  });

  it("says when a photo came with no text", () => {
    const p = chatUserPrompt({ authorDisplayName: "Sam", content: "", files, shown: new Set() }, turn);
    expect(p).toContain("(no text — just the files below)");
  });

  it("reports files that were not saved", () => {
    const p = chatUserPrompt({ authorDisplayName: "Sam", content: "x", skippedFiles: ["clip.mp4: video files aren't used"] }, turn);
    expect(p).toMatch(/Not saved:\n- clip\.mp4/);
  });

  it("adds nothing when nothing was posted", () => {
    expect(chatUserPrompt({ authorDisplayName: "Sam", content: "hi" }, turn)).not.toMatch(/Files they posted/);
  });
});

describe("briefUserPrompt", () => {
  it("carries the bot's note about what a scheduled run may do", () => {
    const p = briefUserPrompt({ name: "morning", prompt: "anything unusual?" }, turn, BRIEF_ONLY_LOOKS);
    expect(p).toMatch(/This run only looks/);
    expect(p.endsWith("anything unusual?")).toBe(true);
    expect(briefUserPrompt({ name: "morning", prompt: "x" }, turn)).not.toMatch(/only looks/);
  });
});

describe("pollAnswerContent", () => {
  it("names the poll and the answer", () => {
    expect(pollAnswerContent({ key: "rooms", question: "Which rooms?" }, ["Kitchen", "Hall"])).toContain(
      "Answers:\n- Kitchen\n- Hall",
    );
  });
});

describe("localStamp", () => {
  it("formats in the given zone", () => {
    expect(localStamp(new Date("2026-01-01T05:00:00Z"), "UTC")).toBe("Thursday 2026-01-01 05:00");
  });
});
