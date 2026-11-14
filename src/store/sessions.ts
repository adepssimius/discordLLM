import type { Db } from "./db.js";
import type { NewSession, Session, SessionKind, SessionStatus } from "../session/types.js";

interface SessionRow {
  id: string;
  profile: string;
  kind: string;
  status: string;
  guild_id: string;
  channel_id: string;
  thread_id: string;
  agent_session_id: string | null;
  opened_by: string | null;
  title: string;
  branch: string;
  schedule_id: number | null;
  turn_count: number;
  agent_turn_count: number;
  cost_usd: number;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  closed_at: number | null;
}

function hydrate(r: SessionRow): Session {
  return {
    id: r.id,
    profile: r.profile,
    kind: r.kind as SessionKind,
    status: r.status as SessionStatus,
    guildId: r.guild_id,
    channelId: r.channel_id,
    threadId: r.thread_id,
    agentSessionId: r.agent_session_id,
    openedBy: r.opened_by,
    title: r.title,
    branch: r.branch,
    scheduleId: r.schedule_id,
    turnCount: r.turn_count,
    agentTurnCount: r.agent_turn_count,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastTurnAt: r.last_turn_at,
    closedAt: r.closed_at,
  };
}

export interface SessionDao {
  byThread(threadId: string): Promise<Session | undefined>;
  byId(id: string): Promise<Session | undefined>;
  create(row: NewSession, now?: number): Promise<Session>;
  /**
   * Looks a session up by a message a brief was posted as.
   *
   * Used twice: when a thread appears whose id is one of those messages, and
   * when someone replies to one in the channel.
   */
  byAnchor(messageId: string): Promise<Session | undefined>;
  addAnchors(sessionId: string, messageIds: readonly string[]): Promise<void>;
  /**
   * Points the session at the thread that now exists for it, and forgets the
   * other anchors: from here on the thread is the only way in, so a second
   * thread started from a different chunk of the same brief is a new
   * conversation rather than a second door into this one.
   */
  bindThread(sessionId: string, threadId: string, now?: number): Promise<void>;
  clearAgentSession(id: string, now?: number): Promise<void>;
  setAgentSession(id: string, agentSessionId: string, now?: number): Promise<void>;
  /** Most recently active first, within one profile. */
  recent(profile: string, limit: number): Promise<readonly Session[]>;
  /** Boot recovery: sessions left mid-run by a crash. */
  resetRunning(now?: number): Promise<number>;
  /** Moves every session of one profile to another. Returns how many moved. */
  relabelProfile(from: string, to: string, now?: number): Promise<number>;
}

export function createSessionDao(db: Db): SessionDao {
  const one = async (sql: string, params: (string | number | null)[]): Promise<Session | undefined> => {
    const r = await db.get<SessionRow>(sql, params);
    return r ? hydrate(r) : undefined;
  };
  const dao: SessionDao = {
    byThread: (threadId) => one("SELECT * FROM sessions WHERE thread_id = ?", [threadId]),
    byId: (id) => one("SELECT * FROM sessions WHERE id = ?", [id]),
    async create(row, now = Date.now()) {
      await db.run(
        `INSERT INTO sessions (id, profile, kind, status, guild_id, channel_id, thread_id, agent_session_id,
           opened_by, title, branch, schedule_id, created_at, updated_at)
         VALUES (?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.profile,
          row.kind,
          row.guildId,
          row.channelId,
          row.threadId,
          row.agentSessionId,
          row.openedBy,
          row.title,
          row.branch,
          row.scheduleId,
          now,
          now,
        ],
      );
      const made = await dao.byId(row.id);
      if (!made) throw new Error(`session ${row.id} vanished after insert`);
      return made;
    },
    byAnchor: (messageId) =>
      one("SELECT s.* FROM sessions s JOIN anchors a ON a.session_id = s.id WHERE a.message_id = ?", [messageId]),
    async addAnchors(sessionId, messageIds) {
      if (messageIds.length === 0) return;
      await db.tx(async (tx) => {
        for (const id of messageIds) {
          await tx.run("INSERT INTO anchors (message_id, session_id) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING", [
            id,
            sessionId,
          ]);
        }
      });
    },
    async bindThread(sessionId, threadId, now = Date.now()) {
      await db.tx(async (tx) => {
        await tx.run("UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ?", [threadId, now, sessionId]);
        await tx.run("DELETE FROM anchors WHERE session_id = ?", [sessionId]);
      });
    },
    async clearAgentSession(id, now = Date.now()) {
      await db.run("UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?", [null, now, id]);
    },
    async setAgentSession(id, agentSessionId, now = Date.now()) {
      await db.run("UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE id = ?", [agentSessionId, now, id]);
    },
    async recent(profile, limit) {
      const rows = await db.all<SessionRow>(
        "SELECT * FROM sessions WHERE profile = ? AND status <> 'closed' ORDER BY COALESCE(last_turn_at, created_at) DESC LIMIT ?",
        [profile, limit],
      );
      return rows.map(hydrate);
    },
    resetRunning: (now = Date.now()) =>
      db.run("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'", [now]),
    relabelProfile: (from, to, now = Date.now()) =>
      db.run("UPDATE sessions SET profile = ?, updated_at = ? WHERE profile = ?", [to, now, from]),
  };
  return dao;
}
