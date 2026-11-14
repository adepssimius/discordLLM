import { describe, expect, it } from "vitest";
import { box, rules, silentLog as log } from "../../test/kit.js";
import type { ApprovalEvent, ApprovalRequest, Approver } from "./approval.js";
import { createGuard, type GuardEvent } from "./guard.js";

const signal = new AbortController().signal;
const o = { signal, toolUseId: "t1" };

const DEL = box("delete_item");
const del = { identifier: "Old drill", confirm: "Old drill" };
const MOVE = box("move_item");
const move = { identifier: "Drill", location: "Garage/Shelf A" };

function guard(
  opts: { level?: string; approver?: Approver; interactive?: boolean; events?: ApprovalEvent[]; audit?: GuardEvent[]; aborted?: () => boolean } = {},
) {
  return createGuard({
    log,
    rules,
    workDir: "/data/workspace",
    interactive: opts.interactive ?? true,
    approvalLevel: opts.level ?? "destructive",
    approver: opts.approver,
    isAborted: opts.aborted,
    onApproval: (e) => opts.events?.push(e),
    onDecision: (e) => opts.audit?.push(e),
  });
}

const approving = (asked: ApprovalRequest[] = []): Approver => async (req) => {
  asked.push(req);
  return { approved: true, by: "u1" };
};
const refusing: Approver = async () => ({ approved: false, by: "u1", reason: "the person denied it" });

describe("authorize", () => {
  it("lets a read through without asking anyone", async () => {
    const asked: ApprovalRequest[] = [];
    expect(await guard({ approver: approving(asked) }).authorize(box("search_items"), { query: "drill" }, o)).toEqual({ allow: true });
    expect(asked).toEqual([]);
  });

  it("lets ordinary edits through without asking at the default level", async () => {
    const asked: ApprovalRequest[] = [];
    expect((await guard({ approver: approving(asked) }).authorize(MOVE, move, o)).allow).toBe(true);
    expect(asked).toEqual([]);
  });

  it("asks before deleting, and goes ahead when approved", async () => {
    const asked: ApprovalRequest[] = [];
    const events: ApprovalEvent[] = [];
    expect((await guard({ approver: approving(asked), events }).authorize(DEL, del, o)).allow).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ toolName: DEL, tier: "destructive", toolUseId: "t1" });
    expect(events[0]?.answer).toEqual({ approved: true, by: "u1" });
  });

  it("refuses when the person says no, and tells the agent not to work around it", async () => {
    const r = await guard({ approver: refusing }).authorize(DEL, del, o);
    expect(r.allow).toBe(false);
    expect(r.message).toMatch(/denied/);
    expect(r.message).toMatch(/do not try to get the same effect another way/);
  });

  it("refuses when there is nobody to ask", async () => {
    expect((await guard().authorize(DEL, del, o)).allow).toBe(false);
  });

  it("asks even for a move at level write, and for nothing at level none", async () => {
    const asked: ApprovalRequest[] = [];
    await guard({ level: "write", approver: approving(asked) }).authorize(MOVE, move, o);
    expect(asked).toHaveLength(1);

    const none: ApprovalRequest[] = [];
    expect((await guard({ level: "none", approver: approving(none) }).authorize(DEL, del, o)).allow).toBe(true);
    expect(none).toEqual([]);
  });

  it("refuses every change in a scheduled run, without asking", async () => {
    const asked: ApprovalRequest[] = [];
    expect((await guard({ interactive: false, approver: approving(asked) }).authorize(MOVE, move, o)).allow).toBe(false);
    expect(asked).toEqual([]);
  });

  it("keeps file tools inside the workspace", async () => {
    const g = guard();
    expect((await g.authorize("Write", { file_path: "/data/workspace/CLAUDE.md", content: "x" }, o)).allow).toBe(true);
    expect((await g.authorize("Read", { file_path: "/proc/self/environ" }, o)).allow).toBe(false);
  });

  it("never asks about a tool the bot does not classify", async () => {
    const asked: ApprovalRequest[] = [];
    expect((await guard({ approver: approving(asked) }).authorize("mcp__bot__poll", { key: "x" }, o)).allow).toBe(true);
    expect(asked).toEqual([]);
  });

  it("refuses everything once the run is stopped", async () => {
    expect((await guard({ aborted: () => true }).authorize(box("get_item"), {}, o)).allow).toBe(false);
  });
});

describe("check, for a backend that sees calls before it can wait", () => {
  it("says a call needs approval without asking for it", () => {
    const asked: ApprovalRequest[] = [];
    const r = guard({ approver: approving(asked) }).check(DEL, del);
    expect(r).toMatchObject({ decision: { allow: true }, needsApproval: true });
    expect(asked).toEqual([]);
  });

  it("stays out of the way of reads and ordinary edits", () => {
    expect(guard().check(MOVE, move).needsApproval).toBe(false);
    expect(guard().check(box("search_items"), {}).needsApproval).toBe(false);
  });

  it("refuses outright what the policy refuses", () => {
    expect(guard({ interactive: false }).check(MOVE, move).decision.allow).toBe(false);
    expect(guard().check(box("attach_document"), { source: "/proc/self/environ" }).decision.allow).toBe(false);
  });
});

describe("the audit", () => {
  it("records each call once, whether the backend checks first or only authorizes", async () => {
    const audit: GuardEvent[] = [];
    const g = guard({ audit, approver: approving() });
    g.check(DEL, del);
    await g.authorize(DEL, del, o);
    await g.authorize(MOVE, move, o);
    expect(audit.map((e) => e.toolName)).toEqual([DEL, MOVE]);
  });

  it("records refusals with their reason", () => {
    const audit: GuardEvent[] = [];
    guard({ audit }).check("Bash", { command: "env" });
    expect(audit[0]?.decision).toMatchObject({ allow: false, reason: expect.stringContaining("no shell") });
  });
});
