/**
 * Schema and forward-only migrations.
 *
 * STRICT tables everywhere: SQLite's default type affinity silently accepts a
 * string in an INTEGER column, and this database is the quota ledger.
 */

import { toDialect, type Db } from "./db.js";

export interface Migration {
  readonly id: number;
  readonly name: string;
  /** Plain SQL, or a function for a migration that has to look before it changes anything. */
  readonly sql?: string;
  readonly run?: (db: Db) => Promise<void>;
}

/**
 * Written in SQLite's spelling; db.ts rewrites the few types that differ for
 * Postgres (see `toDialect`). Booleans are 0/1 integers and times are epoch
 * milliseconds in both, so the DAOs read rows the same way from either.
 */

/** Bootstrapped by migrate() before any migration runs. */
export const SCHEMA_MIGRATIONS =
  "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;";

export const INIT = `
CREATE TABLE schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  cron        TEXT    NOT NULL,
  prompt      TEXT    NOT NULL,
  channel_id  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER
) STRICT;

CREATE UNIQUE INDEX schedules_name ON schedules(name);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled = 1;

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  kind             TEXT    NOT NULL CHECK (kind IN ('chat','brief')),
  status           TEXT    NOT NULL CHECK (status IN ('idle','running','closed')),
  guild_id         TEXT    NOT NULL,
  channel_id       TEXT    NOT NULL,
  thread_id        TEXT    NOT NULL,
  agent_session_id TEXT,
  opened_by        TEXT,
  title            TEXT    NOT NULL DEFAULT '',
  -- No foreign key: deleting a schedule must not take its past briefs with it.
  schedule_id      INTEGER,
  turn_count       INTEGER NOT NULL DEFAULT 0,
  agent_turn_count INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_turn_at     INTEGER,
  closed_at        INTEGER
) STRICT;

-- One session per Discord thread. This is what makes thread_id a safe lookup key.
CREATE UNIQUE INDEX sessions_thread ON sessions(thread_id);
CREATE INDEX sessions_recent ON sessions(updated_at);

-- Every message a scheduled brief was posted as. A thread started from any of
-- them carries that message's id, and is matched back to the session here.
CREATE TABLE anchors (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX anchors_session ON anchors(session_id);

CREATE TABLE turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('running','ok','error','interrupted','aborted')),
  trigger            TEXT    NOT NULL CHECK (trigger IN ('mention','thread_message','schedule')),
  actor_id           TEXT,
  prompt             TEXT    NOT NULL,
  resumed_from       TEXT,
  result             TEXT,
  error              TEXT,
  error_subtype      TEXT,
  num_turns          INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0,
  denied_tool_count  INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  discord_message_id TEXT
) STRICT;

CREATE UNIQUE INDEX turns_session_seq ON turns(session_id, seq);
CREATE INDEX turns_budget    ON turns(started_at);
CREATE INDEX turns_running   ON turns(id) WHERE status = 'running';

CREATE TABLE tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id     INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  input_json  TEXT    NOT NULL,
  allowed     INTEGER NOT NULL CHECK (allowed IN (0,1)),
  deny_reason TEXT,
  at          INTEGER NOT NULL
) STRICT;

CREATE INDEX tool_calls_turn   ON tool_calls(turn_id);
CREATE INDEX tool_calls_denied ON tool_calls(at) WHERE allowed = 0;

CREATE TABLE runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

/**
 * Polls the bot has posted. Keyed by the Discord message, because that is all a
 * vote event carries: which poll message, which answer, which user.
 */
export const POLLS = `
CREATE TABLE polls (
  message_id  TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_id  TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  question    TEXT    NOT NULL,
  options     TEXT    NOT NULL,
  multi       INTEGER NOT NULL CHECK (multi IN (0,1)),
  created_at  INTEGER NOT NULL,
  answered_at INTEGER,
  answer      TEXT
) STRICT;

CREATE INDEX polls_session ON polls(session_id);
`;

/**
 * Every call that waited for a person, and what they said.
 * Separate from tool_calls because the question here is "who let that
 * happen", which deserves an answer that does not depend on reading inputs.
 */
const APPROVALS = `
CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id      INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id   TEXT    NOT NULL,
  tool_name    TEXT    NOT NULL,
  input_json   TEXT    NOT NULL,
  tier         TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  approved     INTEGER NOT NULL CHECK (approved IN (0,1)),
  answered_by  TEXT,
  deny_reason  TEXT,
  at           INTEGER NOT NULL
) STRICT;

CREATE INDEX approvals_at ON approvals(at);
`;

async function hasTable(db: Db, table: string): Promise<boolean> {
  const row =
    db.dialect === "sqlite"
      ? await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      : await db.get("SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?", [table]);
  return row !== undefined;
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  if (db.dialect === "sqlite") {
    return (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).some((c) => c.name === column);
  }
  const row = await db.get(
    "SELECT 1 AS x FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
    [table, column],
  );
  return row !== undefined;
}

/**
 * One shape for every bot built on this library.
 *
 * The bots that came before it each carried their own copy of this file, and
 * the copies had drifted: one had an `approvals` table and no profiles, one
 * had profiles and a `branch` on every session and no approvals. Their first
 * three migrations therefore differ, and this one looks at what is actually
 * there and adds what is missing, so any of those databases opens here with
 * its rows intact:
 *
 *  - `profile` on sessions and schedules, with schedule names unique per
 *    profile. Existing rows belong to `default`.
 *  - `branch` on sessions: the label a per-thread workspace gives a session
 *    (a git branch). Empty for a bot whose threads share one directory.
 *  - `approvals`, with no fixed list of tiers — the ladder is the bot's.
 */
async function unify(db: Db): Promise<void> {
  if (!(await hasColumn(db, "sessions", "profile"))) {
    await db.exec(`
      ALTER TABLE sessions  ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE schedules ADD COLUMN profile TEXT NOT NULL DEFAULT 'default';
      DROP INDEX IF EXISTS schedules_name;
      CREATE UNIQUE INDEX schedules_profile_name ON schedules(profile, name);
    `);
  }
  if (!(await hasColumn(db, "sessions", "branch"))) {
    await db.exec("ALTER TABLE sessions ADD COLUMN branch TEXT NOT NULL DEFAULT ''");
  }
  if (!(await hasTable(db, "approvals"))) await db.exec(toDialect(APPROVALS, db.dialect));
}

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "init", sql: INIT },
  { id: 2, name: "polls", sql: POLLS },
  { id: 3, name: "approvals", sql: APPROVALS },
  { id: 4, name: "unify", run: unify },
];
