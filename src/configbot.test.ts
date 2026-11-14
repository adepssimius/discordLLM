import { describe, expect, it } from "vitest";
import { silentLog } from "../test/kit.js";
import { loadCore, loadProfiles } from "./config.js";
import { BotFileSchema, configBot } from "./configbot.js";
import { toolCall } from "./definition.js";

const file = BotFileSchema.parse({
  name: "boxbot",
  about: "You help look after a household inventory.",
  servers: {
    homebox: { command: "homebox-mcp", env: { HOMEBOX_URL: "${HOMEBOX_URL}", HOMEBOX_TOKEN: "${HOMEBOX_TOKEN}" } },
    notes: { url: "https://notes.example/mcp", headers: { Authorization: "Bearer ${NOTES_KEY}" } },
  },
  tools: { read: ["inventory_stats"], destructive: ["import_csv"] },
});

async function domain(env: Record<string, string>) {
  const e = { DATA_DIR: "/tmp/cfgbot", PATH: "/bin", ...env } as NodeJS.ProcessEnv;
  const def = configBot(file, e);
  const p = loadProfiles(def, loadCore(def, e), e)[0]!;
  return { def, cfg: p.cfg, domain: await def.setup({ cfg: p.cfg, env: p.env, log: silentLog, shared: undefined, sessions: { byId: async () => undefined } }) };
}

describe("a bot from a file", () => {
  it("fills servers in from the environment, each token in its own server only", async () => {
    const { domain: d } = await domain({ HOMEBOX_URL: "http://hb", HOMEBOX_TOKEN: "hb-secret", NOTES_KEY: "nk" });
    expect(d.servers.homebox).toMatchObject({ type: "stdio", command: "homebox-mcp", env: { HOMEBOX_URL: "http://hb", HOMEBOX_TOKEN: "hb-secret" } });
    expect(d.servers.notes).toMatchObject({ type: "http", url: "https://notes.example/mcp", headers: { Authorization: "Bearer nk" } });
    expect(d.agentEnv).toBeUndefined();
    expect(JSON.stringify(d.servers.notes)).not.toContain("hb-secret");
  });

  it("leaves out a server whose variables are not set, rather than starting it half-configured", async () => {
    const { domain: d } = await domain({ HOMEBOX_URL: "http://hb", HOMEBOX_TOKEN: "t" });
    expect(Object.keys(d.servers)).toEqual(["homebox"]);
  });

  it("treats every variable it names as a secret for the logs", async () => {
    const { def } = await domain({});
    expect(def.secrets).toEqual(expect.arrayContaining(["HOMEBOX_URL", "HOMEBOX_TOKEN", "NOTES_KEY"]));
  });

  it("sorts its servers' tools onto the default ladder, with the file's corrections", async () => {
    const { domain: d, def } = await domain({});
    const tier = (n: string): string | undefined => d.classify?.(toolCall(n, {}))?.tier;
    expect(def.tiers).toEqual(["read", "write", "destructive"]);
    expect(tier("mcp__homebox__inventory_stats")).toBe("read");
    expect(tier("mcp__homebox__import_csv")).toBe("destructive");
    expect(tier("mcp__homebox__move_item")).toBe("write");
    // Still gated when the server could not start: the ladder is the file's, not the environment's.
    expect(tier("mcp__notes__delete_note")).toBe("destructive");
  });

  it("refuses a file that is not a bot", () => {
    expect(() => BotFileSchema.parse({ name: "Has Spaces", about: "x" })).toThrow();
    expect(() => BotFileSchema.parse({ name: "ok" })).toThrow();
  });
});
