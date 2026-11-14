import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { box, boxbot, classify, policy, silentLog as log } from "../../test/kit.js";
import { scriptedBackend, type Scripted } from "../../test/scripted.js";
import { tool } from "../agent/backend.js";
import type { Approver } from "../agent/approval.js";
import { loadCore, loadProfiles, type Config } from "../config.js";
import type { Domain } from "../definition.js";
import { QuotaGuard } from "../quota/budget.js";
import { openStore, type Store } from "../store/index.js";
import { sharedWorkspace } from "../workspace.js";
import { recoverInterrupted, SessionManager } from "./manager.js";
import type { Session } from "./types.js";

/**
 * The whole turn, with a scripted stand-in for the model: what the ledger
 * records, what the model is and is not allowed to do, and what comes back for
 * Discord. Nothing here knows which model a real bot would use — which is the
 * point: the manager speaks only the backend interface.
 */

let dir: string;
let store: Store;
let backend: Scripted;
let cfg: Config;
const shipped: string[] = [];

function manager(over: { domain?: Partial<Domain>; env?: Record<string, string>; quota?: boolean } = {}): SessionManager {
  const env = { DATA_DIR: dir, ...over.env } as NodeJS.ProcessEnv;
  cfg = loadProfiles(boxbot, loadCore(boxbot, env), env)[0]!.cfg;
  const workspace = sharedWorkspace({ dir: cfg.workDir, notesSeed: "# Notes\n" });
  const domain: Domain = {
    servers: { box: { type: "stdio", command: "box-mcp", env: { BOX_TOKEN: "box-secret" } } },
    classify,
    policy,
    agentEnv: { EXTRA: "1" },
    turn: async (info) => {
      await workspace.init();
      return {
        systemPrompt: `You look after a box. Level: ${info.approvalLevel}.`,
        headerLines: ["- Shelf: A"],
        tools: info.interactive
          ? [
              tool("ship", "Publish.", { message: z.string() }, async (a) => {
                shipped.push(a.message);
                return { content: [{ type: "text", text: "shipped" }] };
              }),
            ]
          : [],
      };
    },
    ...over.domain,
  };
  return new SessionManager({
    cfg,
    log,
    store,
    def: boxbot,
    backend,
    domain,
    workspace,
    ...(over.quota ? { quota: new QuotaGuard(cfg, log, store) } : {}),
  });
}

const open = (m: SessionManager, threadId = "t1"): Promise<Session> =>
  m.openChat({ guildId: "g", channelId: "123456789", threadId, openedBy: "u1", title: "where is the drill" });

const chat = (m: SessionManager, session: Session, content: string, approver?: Approver) =>
  m.runChatTurn({ session, trigger: "mention", actorId: "u1", message: { authorDisplayName: "Sam", content }, approver });

const fresh = async (s: Session): Promise<Session> => (await store.sessions.byId(s.id))!;
const yes: Approver = async () => ({ approved: true, by: "u9" });
const no: Approver = async () => ({ approved: false, by: "u9", reason: "the person denied it" });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "discordllm-mgr-"));
  store = await openStore(":memory:");
  backend = scriptedBackend();
  shipped.length = 0;
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a turn", () => {
  it("delivers everything the model wrote, in order, and books it in the ledger", async () => {
    const m = manager();
    const s = await open(m);
    backend.script = [{ say: "It's on Garage/Shelf A." }, { call: box("get_item"), input: { identifier: "drill" } }, { say: "Noted that." }];

    const r = await chat(m, s, "where is the drill?");
    if (r.blocked) throw new Error(r.message);
    expect(r).toMatchObject({ ok: true, text: "It's on Garage/Shelf A.\n\nNoted that.", numTurns: 3, deniedTools: 0 });

    expect(await fresh(s)).toMatchObject({ status: "idle", turnCount: 1, agentTurnCount: 3 });
    const turn = await store.turns.byId(r.turnId);
    expect(turn).toMatchObject({ status: "ok", result: "It's on Garage/Shelf A.\n\nNoted that.", actorId: "u1" });
    expect(await store.raw.all("SELECT tool_name, allowed FROM tool_calls")).toEqual([{ tool_name: box("get_item"), allowed: 1 }]);
  });

  it("hands the backend a complete, neutral description of the run", async () => {
    const m = manager();
    backend.script = [{ say: "ok" }];
    await chat(m, await open(m), "hello");

    const run = backend.runs[0]!;
    expect(run.workDir).toBe(join(dir, "workspace"));
    expect(run.systemPrompt).toBe("You look after a box. Level: destructive.");
    expect(run.prompt.text).toContain("- Shelf: A");
    expect(run.prompt.text).toContain("Sam says:\n\nhello");
    expect(run.prompt.text.charAt(0)).not.toBe("<");
    expect(Object.keys(run.servers)).toEqual(["box"]);
    expect(run.toolServer).toBe("bot");
    expect(run.tools.map((t) => t.name)).toEqual(["poll", "schedule_list", "schedule_set", "schedule_delete", "schedule_run_now", "ship"]);
    expect(run.shell).toBe(false);
    expect(run.builtinTools).not.toContain("Bash");
    expect(run.env).toEqual({ EXTRA: "1" });
    expect(run.title).toBe("where is the drill");
    expect(run.sessionId).toBeTypeOf("string");
    expect(run.resume).toBeUndefined();
    // The notes were seeded where the agent stands.
    expect(readFileSync(join(run.workDir, "CLAUDE.md"), "utf8")).toBe("# Notes\n");
  });

  it("continues the same conversation on the next turn, and rebuilds from a recap if the backend lost it", async () => {
    const m = manager();
    const s = await open(m);
    backend.script = [{ say: "On shelf A." }];
    await chat(m, s, "where is the drill?");
    const id = backend.runs[0]!.sessionId!;

    const second = await chat(m, await fresh(s), "and the saw?");
    expect(backend.runs[1]).toMatchObject({ resume: id });
    expect(backend.runs[1]!.sessionId).toBeUndefined();
    expect(second).toMatchObject({ contextRebuilt: false });

    backend.forget(id);
    const third = await chat(m, await fresh(s), "what did I ask first?");
    expect(third).toMatchObject({ contextRebuilt: true });
    expect(backend.runs[2]!.resume).toBeUndefined();
    expect(backend.runs[2]!.prompt.text).toContain("They wrote: Sam says:\n\nwhere is the drill?");
    expect(backend.runs[2]!.prompt.text).toContain("You answered: On shelf A.");
  });
});

describe("what the model may do", () => {
  it("waits for a person before a destructive call, and records who let it through", async () => {
    const m = manager();
    const s = await open(m);
    backend.script = [{ call: box("delete_item"), input: { identifier: "Old drill" } }, { say: "Deleted." }];

    await chat(m, s, "delete the old drill", yes);
    expect(backend.calls).toEqual([{ tool: box("delete_item"), result: "allowed" }]);
    expect(await store.raw.all("SELECT tier, approved, answered_by FROM approvals")).toEqual([{ tier: "destructive", approved: 1, answered_by: "u9" }]);
  });

  it("does not make the call when the person says no, and counts the refusal", async () => {
    const m = manager();
    backend.script = [{ call: box("delete_item"), input: { identifier: "Old drill" } }, { say: "I didn't delete it." }];
    const r = await chat(m, await open(m), "delete the old drill", no);
    expect(backend.calls[0]?.result).toMatch(/Not done: the person denied it/);
    expect(r).toMatchObject({ deniedTools: 1 });
    expect(await store.raw.all("SELECT approved, deny_reason FROM approvals")).toEqual([{ approved: 0, deny_reason: "the person denied it" }]);
  });

  it("asks about an ordinary edit only when the profile's level says so", async () => {
    const asked: string[] = [];
    const watch: Approver = async (req) => {
      asked.push(req.tier);
      return { approved: true, by: "u9" };
    };
    backend.script = [{ call: box("move_item"), input: {} }];
    let m = manager();
    await chat(m, await open(m, "a"), "move it", watch);
    expect(asked).toEqual([]);
    m = manager({ env: { APPROVAL_LEVEL: "write" } });
    await chat(m, await open(m, "b"), "move it", watch);
    expect(asked).toEqual(["write"]);
  });

  it("refuses what the library's rules and the bot's rules refuse, and audits the attempt", async () => {
    const m = manager();
    backend.script = [
      { call: "Bash", input: { command: "env" } },
      { call: "Read", input: { file_path: "/proc/self/environ" } },
      { call: box("attach_document"), input: { source: "/proc/self/environ" } },
      { call: "Write", input: { file_path: "CLAUDE.md", content: "x" } },
    ];
    const r = await chat(m, await open(m), "poke around", yes);
    expect(backend.calls.map((c) => c.result === "allowed")).toEqual([false, false, false, true]);
    expect(r).toMatchObject({ deniedTools: 3 });
    const denied = await store.raw.all<{ tool_name: string }>("SELECT tool_name FROM tool_calls WHERE allowed = 0 ORDER BY id");
    expect(denied.map((d) => d.tool_name)).toEqual(["Bash", "Read", box("attach_document")]);
  });

  it("runs the bot's own tool, which is the only way anything gets published", async () => {
    const m = manager();
    backend.script = [{ call: "mcp__bot__ship", input: { message: "log the run" } }, { say: "Shipped." }];
    await chat(m, await open(m), "push it");
    expect(shipped).toEqual(["log the run"]);
  });
});

describe("a scheduled run", () => {
  const schedule = () =>
    store.schedules.upsert({ profile: "default", name: "morning", cron: "0 7 * * *", prompt: "Anything unusual?", channelId: null, enabled: true, createdBy: null, nextRunAt: 1 });

  it("only looks: every change is refused without anyone being asked, and the bot's write tools do not exist", async () => {
    const m = manager();
    const s = await schedule();
    const brief = await m.openBrief({ guildId: "g", channelId: "123456789", anchorId: "msg-1", schedule: s });
    backend.script = [
      { call: box("list_items") },
      { call: box("move_item") },
      { call: "mcp__bot__ship", input: { message: "x" } },
      { call: "mcp__bot__schedule_set", input: {} },
      { say: "Nothing unusual." },
    ];

    const r = await m.runBriefTurn(brief, s);
    if (r.blocked) throw new Error(r.message);
    expect(backend.calls.map((c) => c.result)).toEqual([
      "allowed",
      expect.stringContaining("scheduled run only looks"),
      "no such tool",
      "no such tool",
    ]);
    expect(shipped).toEqual([]);
    expect(backend.runs[0]!.tools.map((t) => t.name)).toEqual(["poll"]);
    expect(backend.runs[0]!.prompt.text).toContain('This is the scheduled brief "morning"');
    expect(backend.runs[0]!.prompt.text).toContain("This run only looks");
    expect(await fresh(brief)).toMatchObject({ kind: "brief", scheduleId: s.id });
  });
});

describe("polls and schedules, asked for through the bot's tools", () => {
  it("queue a poll for after the reply, and no more than three", async () => {
    const m = manager();
    const ask = (key: string) => ({ call: "mcp__bot__poll", input: { key, question: "Which shelf?", options: ["A", "B"], multi: false } });
    backend.script = [ask("a"), ask("b"), ask("c"), ask("d"), { say: "Poll below." }];
    const r = await chat(m, await open(m), "which?");
    if (r.blocked) throw new Error(r.message);
    expect(r.polls.map((p) => p.key)).toEqual(["a", "b", "c"]);
    expect(backend.calls[3]?.result).toMatch(/at most 3 polls/);
  });

  it("save a schedule against the profile and the channel it was asked in", async () => {
    const m = manager();
    backend.script = [{ call: "mcp__bot__schedule_set", input: { name: "warranties", cron: "0 7 1 * *", prompt: "List warranties expiring soon.", enabled: true } }];
    await chat(m, await open(m), "every month…");
    expect(await store.schedules.byName("default", "warranties")).toMatchObject({ channelId: "123456789", createdBy: "u1", enabled: true });
  });
});

describe("when things go wrong", () => {
  it("books a failed run as an error, with what it spent", async () => {
    const m = manager();
    const s = await open(m);
    backend.fail = "provider is down";
    const r = await chat(m, s, "hello");
    if (r.blocked) throw new Error(r.message);
    expect(r).toMatchObject({ ok: false, text: "_The run failed: provider is down_", numTurns: 1 });
    expect(await store.turns.byId(r.turnId)).toMatchObject({ status: "error", error: "provider is down" });
    expect(await fresh(s)).toMatchObject({ status: "idle", agentTurnCount: 1 });
  });

  it("treats a backend that throws as a failed run, not a crashed bot", async () => {
    const m = manager();
    backend.run = async () => {
      throw new Error("boom");
    };
    const r = await chat(m, await open(m), "hello");
    expect(r).toMatchObject({ blocked: false, ok: false });
  });

  it("stops a run at the next step when told to, and clears the flag for the next message", async () => {
    const m = manager();
    const s = await open(m);
    m.abort(s.id);
    backend.script = [{ say: "working" }];
    const r = await chat(m, s, "hello");
    expect(r).toMatchObject({ ok: false, text: "_Stopped._" });
    expect(m.isAborted(s.id)).toBe(false);
    expect((await store.turns.byId((r as { turnId: number }).turnId))?.status).toBe("aborted");
  });

  it("spends nothing when the hourly budget is gone", async () => {
    const m = manager({ env: { AGENT_TURNS_PER_HOUR: "2" }, quota: true });
    const s = await open(m);
    backend.script = [{ say: "a" }, { say: "b" }];
    await chat(m, s, "one");
    const r = await chat(m, await fresh(s), "two");
    expect(r.blocked).toBe(true);
    expect(backend.runs).toHaveLength(1);
    expect(await store.turns.runningCount()).toBe(0);
  });

  it("recovers a turn that a restart cut off, without retrying it", async () => {
    const m = manager();
    const s = await open(m);
    await store.turns.begin({ sessionId: s.id, trigger: "mention", actorId: "u1", prompt: "p", resumedFrom: null });
    const { interrupted } = await recoverInterrupted(store, log);
    expect(interrupted.map((x) => x.id)).toEqual([s.id]);
    expect(await fresh(s)).toMatchObject({ status: "idle" });
    expect(backend.runs).toEqual([]);
  });
});
