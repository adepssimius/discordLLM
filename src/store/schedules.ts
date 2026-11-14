import type { Db } from "./db.js";
import type { NewSchedule, Schedule } from "../session/types.js";

interface ScheduleRow {
  id: number;
  profile: string;
  name: string;
  cron: string;
  prompt: string;
  channel_id: string | null;
  enabled: number;
  created_by: string | null;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

function hydrate(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    profile: r.profile,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    channelId: r.channel_id,
    enabled: Number(r.enabled) === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

export interface ScheduleDao {
  /** One profile's schedules, or every profile's when none is given. */
  list(profile?: string): Promise<readonly Schedule[]>;
  byId(id: number): Promise<Schedule | undefined>;
  byName(profile: string, name: string): Promise<Schedule | undefined>;
  /** Creates the schedule, or replaces the one with the same name in the same profile. */
  upsert(row: NewSchedule, now?: number): Promise<Schedule>;
  delete(profile: string, name: string): Promise<boolean>;
  /** Enabled schedules of every profile whose next run is at or before `now`. */
  due(now: number): Promise<readonly Schedule[]>;
  /**
   * Moves a schedule on to its next run. Called BEFORE the brief is produced,
   * so a crash mid-run costs one missed brief rather than a brief on every
   * restart.
   */
  advance(id: number, nextRunAt: number | null, ranAt: number | null): Promise<void>;
  /** Moves every schedule of one profile to another. Returns how many moved. */
  relabelProfile(from: string, to: string): Promise<number>;
}

export function createScheduleDao(db: Db): ScheduleDao {
  const dao: ScheduleDao = {
    async list(profile) {
      const rows =
        profile === undefined
          ? await db.all<ScheduleRow>("SELECT * FROM schedules ORDER BY profile, name")
          : await db.all<ScheduleRow>("SELECT * FROM schedules WHERE profile = ? ORDER BY name", [profile]);
      return rows.map(hydrate);
    },
    async byId(id) {
      const r = await db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", [id]);
      return r ? hydrate(r) : undefined;
    },
    async byName(profile, name) {
      const r = await db.get<ScheduleRow>("SELECT * FROM schedules WHERE profile = ? AND name = ?", [profile, name]);
      return r ? hydrate(r) : undefined;
    },
    async upsert(row, now = Date.now()) {
      await db.run(
        `INSERT INTO schedules (profile, name, cron, prompt, channel_id, enabled, created_by, created_at, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile, name) DO UPDATE SET
           cron = excluded.cron, prompt = excluded.prompt, channel_id = excluded.channel_id,
           enabled = excluded.enabled, next_run_at = excluded.next_run_at`,
        [row.profile, row.name, row.cron, row.prompt, row.channelId, row.enabled ? 1 : 0, row.createdBy, now, row.nextRunAt],
      );
      const saved = await dao.byName(row.profile, row.name);
      if (!saved) throw new Error(`schedule ${row.name} vanished after upsert`);
      return saved;
    },
    async delete(profile, name) {
      return (await db.run("DELETE FROM schedules WHERE profile = ? AND name = ?", [profile, name])) > 0;
    },
    async due(now) {
      const rows = await db.all<ScheduleRow>(
        "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
        [now],
      );
      return rows.map(hydrate);
    },
    async advance(id, nextRunAt, ranAt) {
      await db.run("UPDATE schedules SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ?", [
        nextRunAt,
        ranAt,
        id,
      ]);
    },
    relabelProfile: (from, to) => db.run("UPDATE schedules SET profile = ? WHERE profile = ?", [to, from]),
  };
  return dao;
}
