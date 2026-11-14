import { openPostgres, openSqlite, type Db } from "./db.js";
import { createSessionDao, type SessionDao } from "./sessions.js";
import { createTurnDao, type TurnDao } from "./turns.js";
import { createScheduleDao, type ScheduleDao } from "./schedules.js";
import { createStateDao, type StateDao } from "./state.js";
import { createPollDao, type PollDao } from "./polls.js";

export interface Store {
  readonly sessions: SessionDao;
  readonly turns: TurnDao;
  readonly schedules: ScheduleDao;
  readonly state: StateDao;
  readonly polls: PollDao;
  close(): Promise<void>;
  readonly raw: Db;
}

export type StoreTarget =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: string; readonly schema?: string | undefined; readonly poolMax?: number | undefined; readonly onError?: (e: Error) => void };

/** Opens the database and brings its schema up to date. */
export async function openStore(target: StoreTarget | string): Promise<Store> {
  const t: StoreTarget = typeof target === "string" ? { kind: "sqlite", path: target } : target;
  const db = t.kind === "sqlite" ? await openSqlite(t.path) : await openPostgres(t);
  return {
    sessions: createSessionDao(db),
    turns: createTurnDao(db),
    schedules: createScheduleDao(db),
    state: createStateDao(db),
    polls: createPollDao(db),
    close: () => db.close(),
    raw: db,
  };
}

export type { SessionDao, TurnDao, ScheduleDao, StateDao, PollDao, Db };
