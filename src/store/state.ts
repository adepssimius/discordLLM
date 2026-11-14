import type { Db } from "./db.js";

/**
 * Small key/value scratchpad for things that must survive a restart but do not
 * deserve a table — chiefly the quota cooldown, so a restart does not
 * immediately re-probe an exhausted subscription limit.
 */
export interface StateDao {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, now?: number): Promise<void>;
  delete(key: string): Promise<void>;
  getJson<T>(key: string): Promise<T | undefined>;
  setJson(key: string, value: unknown, now?: number): Promise<void>;
}

export function createStateDao(db: Db): StateDao {
  const dao: StateDao = {
    async get(key) {
      return (await db.get<{ value: string }>("SELECT value FROM runtime_state WHERE key = ?", [key]))?.value;
    },
    async set(key, value, now = Date.now()) {
      await db.run(
        `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, now],
      );
    },
    async delete(key) {
      await db.run("DELETE FROM runtime_state WHERE key = ?", [key]);
    },
    async getJson<T>(key: string): Promise<T | undefined> {
      const raw = await dao.get(key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    setJson: (key, value, now = Date.now()) => dao.set(key, JSON.stringify(value), now),
  };
  return dao;
}
