import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewSession } from "../session/types.js";
import { numbered, toDialect } from "./db.js";
import { openStore, type Store, type StoreTarget } from "./index.js";
import { INIT, POLLS } from "./schema.js";

/**
 * Every test here runs on both drivers: the DAOs are written once, and this
 * is what says they mean the same thing on each.
 *
 * Postgres is PGlite by default — real Postgres, compiled to WASM, served on
 * a local socket so the `pg` driver talks to it exactly as it would a server.
 * It is one backend behind a multiplexer, so the pool is held to one
 * connection. Set TEST_DATABASE_URL to run against a real server instead;
 * each test then gets a schema of its own, dropped afterwards.
 */
const PG_URL = process.env.TEST_DATABASE_URL;
const drivers: { name: string; open: () => Promise<{ store: Store; drop: () => Promise<void> }> }[] = [
  {
    name: "sqlite",
    open: async () => {
      const store = await openStore(":memory:");
      return { store, drop: () => store.close() };
    },
  },
];
if (!PG_URL) {
  drivers.push({
    name: "postgres (pglite)",
    open: async () => {
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
      await server.start();
      const store = await openStore({ kind: "postgres", url: `postgres://postgres:postgres@${server.getServerConn()}/postgres`, poolMax: 1 });
      return {
        store,
        drop: async () => {
          await store.close();
          await server.stop();
          await db.close();
        },
      };
    },
  });
} else {
  drivers.push({
    name: "postgres",
    open: async () => {
      const schema = `t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const target: StoreTarget = { kind: "postgres", url: PG_URL, schema };
      const store = await openStore(target);
      return {
        store,
        drop: async () => {
          await store.raw.exec(`DROP SCHEMA ${schema} CASCADE`);
          await store.close();
        },
      };
    },
  });
}

describe.each(drivers)("store on $name", ({ open }) => {
  let store: Store;
  let drop: () => Promise<void>;

  beforeEach(async () => {
    ({ store, drop } = await open());
  });
  afterEach(async () => {
    await drop();
  });

  const newSession = (over: Partial<NewSession> = {}) =>
    store.sessions.create({
      id: randomUUID(),
      profile: "default",
      kind: "chat",
      guildId: "g1",
      channelId: "c1",
      threadId: `t-${randomUUID()}`,
      agentSessionId: randomUUID(),
      openedBy: "u1",
      title: "test",
      branch: "",
      scheduleId: null,
      ...over,
    });

  const begin = (sessionId: string, at?: number) =>
    store.turns.begin({ sessionId, trigger: "mention", actorId: "u1", prompt: "p", resumedFrom: null }, at);

  const ok = { status: "ok" as const, result: "a", error: null, errorSubtype: null, numTurns: 3, costUsd: 0.25, deniedToolCount: 0 };

  describe("migrations", () => {
    it("apply once, in order", async () => {
      const rows = await store.raw.all<{ id: number; name: string }>("SELECT id, name FROM schema_migrations ORDER BY id");
      expect(rows.map((r) => [Number(r.id), r.name])).toEqual([
        [1, "init"],
        [2, "polls"],
        [3, "approvals"],
        [4, "unify"],
      ]);
    });

    it("refuse a string where the quota ledger wants a number", async () => {
      const s = await newSession();
      await expect(store.raw.run("UPDATE sessions SET agent_turn_count = ? WHERE id = ?", ["lots", s.id])).rejects.toThrow();
    });
  });

  describe("sessions", () => {
    it("are found by thread, with the profile and branch they were given", async () => {
      const s = await newSession({ threadId: "t1", profile: "sam", branch: "fit/2026-10-02-long-run" });
      expect(await store.sessions.byThread("t1")).toMatchObject({ id: s.id, profile: "sam", branch: "fit/2026-10-02-long-run" });
      expect(await store.sessions.byThread("nope")).toBeUndefined();
    });

    it("refuse a second session on the same thread", async () => {
      await newSession({ threadId: "t1" });
      await expect(newSession({ threadId: "t1" })).rejects.toThrow();
    });

    it("list the most recently active first, within a profile", async () => {
      const old = await newSession();
      const fresh = await newSession();
      await newSession({ profile: "alex" });
      await store.turns.finish(await begin(fresh.id, 1_000), ok, 2_000);
      await store.turns.finish(await begin(old.id, 3_000), ok, 4_000);
      expect((await store.sessions.recent("default", 10)).map((s) => s.id)).toEqual([old.id, fresh.id]);
    });

    it("are found by any message a brief was posted as, until a thread takes over", async () => {
      const s = await newSession({ kind: "brief", threadId: "m1" });
      await store.sessions.addAnchors(s.id, ["m1", "m2", "m2"]);
      expect((await store.sessions.byAnchor("m2"))?.id).toBe(s.id);
      await store.sessions.bindThread(s.id, "thread-9");
      expect(await store.sessions.byAnchor("m2")).toBeUndefined();
      expect((await store.sessions.byThread("thread-9"))?.id).toBe(s.id);
    });
  });

  describe("turns", () => {
    it("number themselves per session and mark the session running", async () => {
      const s = await newSession();
      const first = await begin(s.id);
      expect((await store.sessions.byId(s.id))?.status).toBe("running");
      await store.turns.finish(first, ok);
      const second = await begin(s.id);
      expect((await store.turns.byId(first))?.seq).toBe(1);
      expect((await store.turns.byId(second))?.seq).toBe(2);
      expect(second).toBeGreaterThan(first);
    });

    it("move the turn and the session's counters together", async () => {
      const s = await newSession();
      await store.turns.finish(await begin(s.id), ok, 5_000);
      expect(await store.sessions.byId(s.id)).toMatchObject({
        status: "idle",
        turnCount: 1,
        agentTurnCount: 3,
        costUsd: 0.25,
        lastTurnAt: 5_000,
      });
    });

    it("leave nothing behind when finishing a turn that does not exist", async () => {
      await expect(store.turns.finish(999_999, ok)).rejects.toThrow(/does not exist/);
    });

    it("add up what the last hour spent, and count what is in flight", async () => {
      const s = await newSession();
      await store.turns.finish(await begin(s.id, 1_000), ok);
      await store.turns.finish(await begin(s.id, 9_000), { ...ok, numTurns: 5 });
      await begin(s.id, 9_500);
      expect(await store.turns.agentTurnsSince(0)).toBe(8);
      expect(await store.turns.agentTurnsSince(5_000)).toBe(5);
      expect(await store.turns.runningCount()).toBe(1);
    });

    it("recover from a crash: running turns become interrupted and sessions idle", async () => {
      const s = await newSession();
      const id = await begin(s.id);
      const running = await store.turns.running();
      expect(running.map((t) => t.id)).toEqual([id]);
      await store.turns.markInterrupted([id]);
      expect(await store.sessions.resetRunning()).toBe(1);
      expect((await store.turns.byId(id))?.status).toBe("interrupted");
      expect((await store.sessions.byId(s.id))?.status).toBe("idle");
    });

    it("return recent answered turns oldest first, for a recap", async () => {
      const s = await newSession();
      for (const result of ["one", "two", "three"]) await store.turns.finish(await begin(s.id), { ...ok, result });
      expect((await store.turns.recent(s.id, 2)).map((t) => t.result)).toEqual(["two", "three"]);
    });

    it("keep the audit of tool calls and approvals, whatever the bot calls its tiers", async () => {
      const s = await newSession();
      const turnId = await begin(s.id);
      await store.turns.recordToolCalls([
        { turnId, sessionId: s.id, toolName: "Read", inputJson: "{}", allowed: true, denyReason: null },
        { turnId, sessionId: s.id, toolName: "Bash", inputJson: "{}", allowed: false, denyReason: "no shell" },
      ]);
      const base = { turnId, sessionId: s.id, toolName: "mcp__ha__ha_call_service", inputJson: "{}", reason: "r" };
      await store.turns.recordApproval({ ...base, tier: "control", approved: true, answeredBy: "u1", denyReason: null });
      await store.turns.recordApproval({ ...base, tier: "destructive", approved: false, answeredBy: null, denyReason: "timed out" });

      const calls = await store.raw.all<{ allowed: number }>("SELECT allowed FROM tool_calls ORDER BY id");
      expect(calls.map((c) => Number(c.allowed))).toEqual([1, 0]);
      const approvals = await store.raw.all<{ tier: string; approved: number; answered_by: string | null }>(
        "SELECT tier, approved, answered_by FROM approvals ORDER BY id",
      );
      expect(approvals.map((a) => [a.tier, Number(a.approved), a.answered_by])).toEqual([
        ["control", 1, "u1"],
        ["destructive", 0, null],
      ]);
    });

    it("take the audit with a session when it is deleted", async () => {
      const s = await newSession();
      const turnId = await begin(s.id);
      await store.turns.recordToolCalls([{ turnId, sessionId: s.id, toolName: "Read", inputJson: "{}", allowed: true, denyReason: null }]);
      await store.raw.run("DELETE FROM sessions WHERE id = ?", [s.id]);
      expect(await store.raw.all("SELECT 1 AS x FROM tool_calls")).toEqual([]);
    });
  });

  describe("schedules", () => {
    const row = {
      profile: "default",
      name: "morning-brief",
      cron: "0 6 * * *",
      prompt: "Run the daily brief.",
      channelId: null,
      enabled: true,
      createdBy: "u1",
      nextRunAt: 1_000,
    };

    it("are replaced by name, keeping their id", async () => {
      const a = await store.schedules.upsert(row);
      const b = await store.schedules.upsert({ ...row, cron: "30 6 * * *", enabled: false });
      expect(b.id).toBe(a.id);
      expect(await store.schedules.byName("default", "morning-brief")).toMatchObject({ cron: "30 6 * * *", enabled: false });
    });

    it("come due only when enabled and past their time, and move on when advanced", async () => {
      const s = await store.schedules.upsert(row);
      await store.schedules.upsert({ ...row, name: "paused", enabled: false });
      expect((await store.schedules.due(999)).length).toBe(0);
      expect((await store.schedules.due(1_000)).map((d) => d.name)).toEqual(["morning-brief"]);
      await store.schedules.advance(s.id, 90_000, 1_500);
      expect(await store.schedules.byId(s.id)).toMatchObject({ nextRunAt: 90_000, lastRunAt: 1_500 });
      // A skipped run moves the clock on without claiming to have run.
      await store.schedules.advance(s.id, 180_000, null);
      expect((await store.schedules.byId(s.id))?.lastRunAt).toBe(1_500);
    });

    it("can be deleted without taking past briefs with them", async () => {
      const s = await store.schedules.upsert(row);
      const brief = await newSession({ kind: "brief", scheduleId: s.id });
      expect(await store.schedules.delete("default", "morning-brief")).toBe(true);
      expect(await store.sessions.byId(brief.id)).toBeDefined();
      expect(await store.schedules.delete("default", "morning-brief")).toBe(false);
    });

    it("let two profiles each have one of the same name", async () => {
      await store.schedules.upsert({ ...row, profile: "sam" });
      await store.schedules.upsert({ ...row, profile: "alex", cron: "30 6 * * *" });
      expect((await store.schedules.list("sam")).map((s) => s.cron)).toEqual(["0 6 * * *"]);
      expect((await store.schedules.list("alex")).map((s) => s.cron)).toEqual(["30 6 * * *"]);
      expect(await store.schedules.list()).toHaveLength(2);
      expect(await store.schedules.due(1_000)).toHaveLength(2);
    });
  });

  describe("polls", () => {
    const post = (sessionId: string, multi = false) =>
      store.polls.create({ messageId: "poll-1", sessionId, channelId: "t1", key: "rooms", question: "Which?", options: ["A", "B", "C"], multi });

    it("are found by the message a vote names", async () => {
      const s = await newSession();
      await post(s.id);
      expect(await store.polls.byMessage("poll-1")).toMatchObject({
        sessionId: s.id,
        options: ["A", "B", "C"],
        multi: false,
        answeredAt: null,
        answer: null,
      });
      expect(await store.polls.byMessage("someone-elses-poll")).toBeUndefined();
    });

    it("take an answer exactly once, so a vote cannot start two turns", async () => {
      await post((await newSession()).id, true);
      expect(await store.polls.answer("poll-1", ["B", "C"])).toBe(true);
      expect(await store.polls.answer("poll-1", ["A"])).toBe(false);
      expect(await store.polls.byMessage("poll-1")).toMatchObject({ multi: true, answer: ["B", "C"] });
    });
  });

  describe("runtime state", () => {
    it("is overwritten in place and survives as JSON", async () => {
      await store.state.setJson("cooldown", { until: 5 });
      await store.state.setJson("cooldown", { until: 9 });
      expect(await store.state.getJson("cooldown")).toEqual({ until: 9 });
      await store.state.delete("cooldown");
      expect(await store.state.get("cooldown")).toBeUndefined();
    });
  });

  describe("profiles", () => {
    it("hand the unnamed profile's rows to the first named one", async () => {
      const old = await newSession();
      await store.schedules.upsert({
        profile: "default", name: "morning-brief", cron: "0 6 * * *", prompt: "p",
        channelId: null, enabled: true, createdBy: null, nextRunAt: 1_000,
      });
      expect(await store.sessions.relabelProfile("default", "sam")).toBe(1);
      expect(await store.schedules.relabelProfile("default", "sam")).toBe(1);
      expect((await store.sessions.byId(old.id))?.profile).toBe("sam");
      expect(await store.sessions.relabelProfile("default", "sam")).toBe(0);
    });
  });

  describe("transactions", () => {
    it("roll back everything when one statement fails", async () => {
      const s = await newSession();
      await expect(
        store.raw.tx(async (tx) => {
          await tx.run("UPDATE sessions SET title = ? WHERE id = ?", ["changed", s.id]);
          await tx.run("INSERT INTO no_such_table (x) VALUES (?)", [1]);
        }),
      ).rejects.toThrow();
      expect((await store.sessions.byId(s.id))?.title).toBe("test");
    });

    it("keep concurrent turns' statements apart", async () => {
      const sessions = await Promise.all(Array.from({ length: 8 }, () => newSession()));
      const ids = await Promise.all(sessions.map((s) => begin(s.id)));
      await Promise.all(ids.map((id) => store.turns.finish(id, ok)));
      expect(new Set(ids).size).toBe(8);
      expect(await store.turns.agentTurnsSince(0)).toBe(24);
      expect(await store.turns.runningCount()).toBe(0);
    });
  });
});

/**
 * The bots that existed before this library each had their own copy of the
 * schema. Their databases must open here with every row intact.
 */
describe("databases from before the library", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "discordllm-legacy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function legacy(name: string, build: (db: DatabaseSync) => void): string {
    const path = join(dir, name);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    build(db);
    db.close();
    return path;
  }
  const mark = (db: DatabaseSync, id: number, name: string): void => {
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, 0)").run(id, name);
  };

  it("opens one with approvals and no profiles (homeboxcordllm, hasscordllm)", async () => {
    const path = legacy("approvals.db", (db) => {
      db.exec(INIT);
      mark(db, 1, "init");
      db.exec(POLLS);
      mark(db, 2, "polls");
      db.exec(`CREATE TABLE approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('read','control','change','destructive')),
        reason TEXT NOT NULL, approved INTEGER NOT NULL CHECK (approved IN (0,1)),
        answered_by TEXT, deny_reason TEXT, at INTEGER NOT NULL) STRICT`);
      mark(db, 3, "approvals");
      db.exec(`INSERT INTO sessions (id, kind, status, guild_id, channel_id, thread_id, title, created_at, updated_at)
               VALUES ('s1', 'chat', 'idle', 'g', 'c', 't1', 'the porch light', 1, 1)`);
      db.exec(`INSERT INTO schedules (name, cron, prompt, created_at, next_run_at) VALUES ('morning', '0 7 * * *', 'p', 1, 5)`);
      db.exec(`INSERT INTO turns (session_id, seq, status, trigger, prompt, started_at) VALUES ('s1', 1, 'ok', 'mention', 'p', 1)`);
      db.exec(`INSERT INTO approvals (turn_id, session_id, tool_name, input_json, tier, reason, approved, at)
               VALUES (1, 's1', 'x', '{}', 'change', 'r', 1, 1)`);
    });

    const store = await openStore(path);
    expect(await store.sessions.byThread("t1")).toMatchObject({ id: "s1", profile: "default", branch: "", title: "the porch light" });
    expect(await store.schedules.byName("default", "morning")).toMatchObject({ cron: "0 7 * * *", nextRunAt: 5 });
    expect(await store.raw.all("SELECT tier FROM approvals")).toEqual([{ tier: "change" }]);
    // And it takes new rows in the new shape.
    await store.schedules.upsert({ profile: "alex", name: "morning", cron: "0 8 * * *", prompt: "p", channelId: null, enabled: true, createdBy: null, nextRunAt: 9 });
    expect(await store.schedules.list()).toHaveLength(2);
    await store.close();

    // Opening it again changes nothing.
    const again = await openStore(path);
    expect(await again.raw.all<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id")).toHaveLength(4);
    await again.close();
  });

  it("opens one with profiles and branches and no approvals (fitcordllm)", async () => {
    const path = legacy("profiles.db", (db) => {
      // Its first migration already had a branch on every session.
      db.exec(INIT.replace("title            TEXT    NOT NULL DEFAULT '',", "title            TEXT    NOT NULL DEFAULT '',\n  branch           TEXT    NOT NULL,"));
      mark(db, 1, "init");
      db.exec(POLLS);
      mark(db, 2, "polls");
      db.exec(`ALTER TABLE sessions  ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
               ALTER TABLE schedules ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
               DROP INDEX schedules_name;
               CREATE UNIQUE INDEX schedules_profile_name ON schedules(profile, name);`);
      mark(db, 3, "profiles");
      db.exec(`INSERT INTO sessions (id, profile, kind, status, guild_id, channel_id, thread_id, title, branch, created_at, updated_at)
               VALUES ('s1', 'sam', 'chat', 'idle', 'g', 'c', 't1', 'long run', 'fitcord/2026-10-02-long-run-abc', 1, 1)`);
    });

    const store = await openStore(path);
    expect(await store.sessions.byThread("t1")).toMatchObject({ profile: "sam", branch: "fitcord/2026-10-02-long-run-abc" });
    const turnId = await store.turns.begin({ sessionId: "s1", trigger: "mention", actorId: null, prompt: "p", resumedFrom: null });
    await store.turns.recordApproval({
      turnId, sessionId: "s1", toolName: "x", inputJson: "{}", tier: "anything", reason: "r", approved: true, answeredBy: null, denyReason: null,
    });
    expect(await store.raw.all("SELECT tier FROM approvals")).toEqual([{ tier: "anything" }]);
    await store.close();
  });
});

describe("dialects", () => {
  it("number placeholders for Postgres", () => {
    expect(numbered("UPDATE t SET a = ?, b = ? WHERE id = ?")).toBe("UPDATE t SET a = $1, b = $2 WHERE id = $3");
  });

  it("spell the schema's types for Postgres and leave SQLite's alone", () => {
    const ddl = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, cost REAL) STRICT;";
    expect(toDialect(ddl, "sqlite")).toBe(ddl);
    expect(toDialect(ddl, "postgres")).toBe(
      "CREATE TABLE t (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, cost DOUBLE PRECISION);",
    );
  });
});
