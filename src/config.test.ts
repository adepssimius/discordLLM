import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boxbot } from "../test/kit.js";
import { ConfigError, effectiveEnv, loadCore, loadProfiles, optionalString, storeTarget } from "./config.js";
import { defineBot } from "./definition.js";

const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: "/tmp/box-test", ...o });
const first = (o: Record<string, string> = {}, def = boxbot) => {
  const e = env(o);
  return loadProfiles(def, loadCore(def, e), e)[0]!;
};

const own = defineBot({
  name: "ownbot",
  tiers: ["read", "write", "destructive"],
  env: { BOX_URL: optionalString, BOX_TOKEN: optionalString, BOX_RETRIES: z.coerce.number().default(3) },
  defaults: { AGENT_MAX_TURNS: "80", APPROVAL_LEVEL: "write" },
  setup: () => ({ servers: {}, turn: () => ({ systemPrompt: "" }) }),
});

describe("core settings", () => {
  it("names the database after the bot and keeps it under DATA_DIR", () => {
    expect(loadCore(boxbot, env()).sqlitePath).toBe("/tmp/box-test/boxbot.db");
    expect(storeTarget(loadCore(boxbot, env()))).toEqual({ kind: "sqlite", path: "/tmp/box-test/boxbot.db" });
  });

  it("uses Postgres when given a URL, in a schema of the bot's own if asked", () => {
    const c = loadCore(boxbot, env({ DATABASE_URL: "postgres://u:p@db/bots", DATABASE_SCHEMA: "boxbot" }));
    expect(storeTarget(c)).toMatchObject({ kind: "postgres", url: "postgres://u:p@db/bots", schema: "boxbot", poolMax: 5 });
  });

  it("refuses a database URL it cannot use rather than quietly using SQLite", () => {
    expect(() => storeTarget(loadCore(boxbot, env({ DATABASE_URL: "mysql://db/x" })))).toThrow(ConfigError);
  });

  it("has no shell among the default built-in tools", () => {
    expect(loadCore(boxbot, env()).AGENT_BUILTIN_TOOLS).not.toContain("Bash");
  });

  it("takes a bot's defaults, and lets the environment override them", () => {
    expect(loadCore(own, env()).AGENT_MAX_TURNS).toBe(80);
    expect(loadCore(own, env({ AGENT_MAX_TURNS: "5" })).AGENT_MAX_TURNS).toBe(5);
    expect(loadCore(boxbot, env()).AGENT_MAX_TURNS).toBe(60);
  });
});

describe("a profile", () => {
  it("derives the workspace and inbox from DATA_DIR", () => {
    const { cfg } = first();
    expect(cfg.name).toBe("default");
    expect(cfg.workDir).toBe("/tmp/box-test/workspace");
    expect(cfg.inboxDir).toBe("/tmp/box-test/workspace/inbox");
  });

  it("asks for approval only at the top of the ladder by default", () => {
    expect(first().cfg.APPROVAL_LEVEL).toBe("destructive");
    expect(first({}, own).cfg.APPROVAL_LEVEL).toBe("write");
  });

  it("refuses an approval level the bot's ladder does not have", () => {
    expect(() => first({ APPROVAL_LEVEL: "change" })).toThrow(/APPROVAL_LEVEL/);
    expect(() => first({ APPROVAL_LEVEL: "read" })).toThrow(ConfigError);
    expect(first({ APPROVAL_LEVEL: "none" }).cfg.APPROVAL_LEVEL).toBe("none");
  });

  it("reads lists, trimming whitespace", () => {
    expect(first({ DISCORD_APPROVER_USER_IDS: "1, 2," }).cfg.DISCORD_APPROVER_USER_IDS).toEqual(["1", "2"]);
  });

  it("refuses a time zone that does not exist", () => {
    expect(() => first({ BOT_TIMEZONE: "Mars/Olympus" })).toThrow(/BOT_TIMEZONE/);
  });

  it("parses the bot's own variables, treating an empty ConfigMap value as unset", () => {
    const p = first({ BOX_URL: "", BOX_TOKEN: "t", BOX_RETRIES: "5" }, own);
    expect(p.env).toEqual({ BOX_URL: undefined, BOX_TOKEN: "t", BOX_RETRIES: 5 });
  });
});

describe("several profiles", () => {
  const e = env({
    BOT_PROFILES: "sam,alex",
    BOT_TIMEZONE: "UTC",
    PROFILE_ALEX_BOT_TIMEZONE: "America/New_York",
    BOX_URL: "http://shared",
    PROFILE_SAM_BOX_TOKEN: "sam-token",
    PROFILE_ALEX_BOX_TOKEN: "alex-token",
    PROFILE_ALEX_APPROVAL_LEVEL: "none",
  });
  const all = loadProfiles(own, loadCore(own, e), e);

  it("read a plain variable as everyone's default and a prefixed one as one profile's", () => {
    expect(all.map((p) => p.cfg.name)).toEqual(["sam", "alex"]);
    expect(all.map((p) => p.cfg.BOT_TIMEZONE)).toEqual(["UTC", "America/New_York"]);
    expect(all.map((p) => p.env.BOX_URL)).toEqual(["http://shared", "http://shared"]);
    expect(all.map((p) => p.env.BOX_TOKEN)).toEqual(["sam-token", "alex-token"]);
    expect(all.map((p) => p.cfg.APPROVAL_LEVEL)).toEqual(["write", "none"]);
  });

  it("each get a working directory of their own", () => {
    expect(all.map((p) => p.cfg.workDir)).toEqual([
      "/tmp/box-test/profiles/sam/workspace",
      "/tmp/box-test/profiles/alex/workspace",
    ]);
  });

  it("refuse a bad or repeated name", () => {
    const bad = env({ BOT_PROFILES: "Sam" });
    expect(() => loadProfiles(own, loadCore(own, bad), bad)).toThrow(/BOT_PROFILES/);
    const twice = env({ BOT_PROFILES: "sam,sam" });
    expect(() => loadProfiles(own, loadCore(own, twice), twice)).toThrow(/listed twice/);
  });
});

describe("older variable names", () => {
  it("still work, plainly and per profile", () => {
    expect(first({ BOX_APPROVAL_LEVEL: "write" }).cfg.APPROVAL_LEVEL).toBe("write");
    const e = env({ OLD_PROFILES: "sam", PROFILE_SAM_BOX_APPROVAL_LEVEL: "none" });
    const p = loadProfiles(boxbot, loadCore(boxbot, e), e)[0]!;
    expect(p.cfg.name).toBe("sam");
    expect(p.cfg.APPROVAL_LEVEL).toBe("none");
  });

  it("lose to the current name", () => {
    expect(effectiveEnv(boxbot, { BOX_APPROVAL_LEVEL: "write", APPROVAL_LEVEL: "none" }).APPROVAL_LEVEL).toBe("none");
  });
});
