import type { Db } from "./db.js";
import type { PollRow } from "../session/types.js";

interface RawPoll {
  message_id: string;
  session_id: string;
  channel_id: string;
  key: string;
  question: string;
  options: string;
  multi: number;
  created_at: number;
  answered_at: number | null;
  answer: string | null;
}

function hydrate(r: RawPoll): PollRow {
  return {
    messageId: r.message_id,
    sessionId: r.session_id,
    channelId: r.channel_id,
    key: r.key,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    multi: Number(r.multi) === 1,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    answer: r.answer === null ? null : (JSON.parse(r.answer) as string[]),
  };
}

export interface PollDao {
  create(
    row: Pick<PollRow, "messageId" | "sessionId" | "channelId" | "key" | "question" | "options" | "multi">,
    now?: number,
  ): Promise<void>;
  byMessage(messageId: string): Promise<PollRow | undefined>;
  /**
   * Records the answer. Returns false if the poll already had one.
   *
   * The conditional UPDATE is the concurrency control: a vote that settles
   * twice, or arrives again after a restart, changes no rows and so starts no
   * second turn.
   */
  answer(messageId: string, chosen: readonly string[], now?: number): Promise<boolean>;
}

export function createPollDao(db: Db): PollDao {
  return {
    async create(row, now = Date.now()) {
      await db.run(
        `INSERT INTO polls (message_id, session_id, channel_id, key, question, options, multi, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.messageId, row.sessionId, row.channelId, row.key, row.question, JSON.stringify(row.options), row.multi ? 1 : 0, now],
      );
    },
    async byMessage(messageId) {
      const r = await db.get<RawPoll>("SELECT * FROM polls WHERE message_id = ?", [messageId]);
      return r ? hydrate(r) : undefined;
    },
    async answer(messageId, chosen, now = Date.now()) {
      const changed = await db.run(
        "UPDATE polls SET answered_at = ?, answer = ? WHERE message_id = ? AND answered_at IS NULL",
        [now, JSON.stringify(chosen), messageId],
      );
      return changed > 0;
    },
  };
}
