import type { Db } from "./db.js";
import type { FinishTurn, NewApproval, NewToolCall, NewTurn, TurnRow, TurnStatus } from "../session/types.js";

interface RawTurn {
  id: number;
  session_id: string;
  seq: number;
  status: string;
  trigger: string;
  actor_id: string | null;
  prompt: string;
  resumed_from: string | null;
  result: string | null;
  error: string | null;
  error_subtype: string | null;
  num_turns: number;
  cost_usd: number;
  denied_tool_count: number;
  started_at: number;
  ended_at: number | null;
  discord_message_id: string | null;
}

function hydrate(r: RawTurn): TurnRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    status: r.status as TurnRow["status"],
    trigger: r.trigger as TurnRow["trigger"],
    actorId: r.actor_id,
    prompt: r.prompt,
    resumedFrom: r.resumed_from,
    result: r.result,
    error: r.error,
    errorSubtype: r.error_subtype,
    numTurns: r.num_turns,
    costUsd: r.cost_usd,
    deniedToolCount: r.denied_tool_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    discordMessageId: r.discord_message_id,
  };
}

export interface TurnDao {
  /** Step 2 of the commit protocol: durable prompt + running session, atomically. */
  begin(t: NewTurn, now?: number): Promise<number>;
  /** Step 4: terminal turn state and session counters, atomically. */
  finish(id: number, r: FinishTurn, now?: number): Promise<void>;
  setDiscordMessage(id: number, messageId: string): Promise<void>;
  byId(id: number): Promise<TurnRow | undefined>;
  recent(sessionId: string, limit: number): Promise<readonly TurnRow[]>;
  recordToolCalls(batch: readonly NewToolCall[], now?: number): Promise<void>;
  recordApproval(a: NewApproval, now?: number): Promise<void>;
  /** Quota ledger: SDK turns spent since a timestamp. */
  agentTurnsSince(epochMs: number): Promise<number>;
  runningCount(): Promise<number>;
  running(): Promise<readonly TurnRow[]>;
  markInterrupted(ids: readonly number[], now?: number): Promise<void>;
}

export function createTurnDao(db: Db): TurnDao {
  return {
    begin(t, now = Date.now()) {
      return db.tx(async (tx) => {
        const next = await tx.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE session_id = ?", [
          t.sessionId,
        ]);
        const made = await tx.get<{ id: number }>(
          `INSERT INTO turns (session_id, seq, status, trigger, actor_id, prompt, resumed_from, started_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?) RETURNING id`,
          [t.sessionId, Number(next?.n ?? 1), t.trigger, t.actorId, t.prompt, t.resumedFrom, now],
        );
        if (!made) throw new Error("begin: the turn row was not created");
        await tx.run("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?", [now, t.sessionId]);
        return Number(made.id);
      });
    },

    async finish(id, r, now = Date.now()) {
      // Turn state and session counters must move together, or the quota ledger
      // drifts from the audit log.
      await db.tx(async (tx) => {
        const row = await tx.get<{ session_id: string }>("SELECT session_id FROM turns WHERE id = ?", [id]);
        if (!row) throw new Error(`finish: turn ${id} does not exist`);
        await tx.run(
          `UPDATE turns SET status = ?, result = ?, error = ?, error_subtype = ?,
             num_turns = ?, cost_usd = ?, denied_tool_count = ?, ended_at = ?
           WHERE id = ?`,
          [r.status, r.result, r.error, r.errorSubtype, r.numTurns, r.costUsd, r.deniedToolCount, now, id],
        );
        await tx.run(
          `UPDATE sessions
             SET status = 'idle',
                 turn_count = turn_count + 1,
                 agent_turn_count = agent_turn_count + ?,
                 cost_usd = cost_usd + ?,
                 last_turn_at = ?, updated_at = ?
           WHERE id = ?`,
          [r.numTurns, r.costUsd, now, now, row.session_id],
        );
      });
    },

    async setDiscordMessage(id, messageId) {
      await db.run("UPDATE turns SET discord_message_id = ? WHERE id = ?", [messageId, id]);
    },

    async byId(id) {
      const r = await db.get<RawTurn>("SELECT * FROM turns WHERE id = ?", [id]);
      return r ? hydrate(r) : undefined;
    },

    async recent(sessionId, limit) {
      const rows = await db.all<RawTurn>(
        "SELECT * FROM turns WHERE session_id = ? AND status = 'ok' ORDER BY seq DESC LIMIT ?",
        [sessionId, limit],
      );
      return rows.map(hydrate).reverse();
    },

    async recordToolCalls(batch, now = Date.now()) {
      if (batch.length === 0) return;
      await db.tx(async (tx) => {
        for (const c of batch) {
          await tx.run(
            `INSERT INTO tool_calls (turn_id, session_id, tool_name, input_json, allowed, deny_reason, at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [c.turnId, c.sessionId, c.toolName, c.inputJson, c.allowed ? 1 : 0, c.denyReason, now],
          );
        }
      });
    },

    async recordApproval(a, now = Date.now()) {
      await db.run(
        `INSERT INTO approvals (turn_id, session_id, tool_name, input_json, tier, reason, approved, answered_by, deny_reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.turnId, a.sessionId, a.toolName, a.inputJson, a.tier, a.reason, a.approved ? 1 : 0, a.answeredBy, a.denyReason, now],
      );
    },

    async agentTurnsSince(epochMs) {
      const r = await db.get<{ n: number }>("SELECT COALESCE(SUM(num_turns), 0) AS n FROM turns WHERE started_at >= ?", [epochMs]);
      return Number(r?.n ?? 0);
    },

    async runningCount() {
      const r = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE status = 'running'");
      return Number(r?.n ?? 0);
    },

    async running() {
      return (await db.all<RawTurn>("SELECT * FROM turns WHERE status = 'running'")).map(hydrate);
    },

    async markInterrupted(ids, now = Date.now()) {
      if (ids.length === 0) return;
      await db.tx(async (tx) => {
        for (const id of ids) {
          await tx.run("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'", [now, id]);
        }
      });
    },
  };
}

export type { TurnStatus };
