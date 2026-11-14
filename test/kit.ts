import { vi } from "vitest";
import { loadCore, loadProfiles, type Config } from "../src/config.js";
import { ALLOW, defineBot, type Domain } from "../src/definition.js";
import type { PolicyRules } from "../src/agent/policy.js";
import { classifyByName, confinePathArgs, DEFAULT_TIERS } from "../src/index.js";
import type { Logger } from "../src/logger.js";

/** A stand-in bot: one MCP server called `box`, the default ladder, path arguments confined. */
export const boxbot = defineBot({
  name: "boxbot",
  tiers: DEFAULT_TIERS,
  envAliases: { BOX_APPROVAL_LEVEL: "APPROVAL_LEVEL", OLD_PROFILES: "BOT_PROFILES" },
  setup: (): Domain => ({
    servers: {},
    classify,
    policy,
    turn: () => ({ systemPrompt: "" }),
  }),
});

export const classify = classifyByName(["box"], { read: ["inventory_stats"], destructive: ["import_csv"] });

export const policy: NonNullable<Domain["policy"]> = (call) =>
  call.server === "box" ? confinePathArgs(call, { known: ["source"], allowUrlIn: ["source"] }) : ALLOW;

export const rules: PolicyRules = { tiers: DEFAULT_TIERS, shell: false, confineReads: true, classify, policy };

export const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

/** The first profile's config, from a bare environment plus `over`. */
export function config(over: Record<string, string> = {}): Config {
  const env = { DATA_DIR: "/data", ...over } as NodeJS.ProcessEnv;
  const first = loadProfiles(boxbot, loadCore(boxbot, env), env)[0];
  if (!first) throw new Error("no profile");
  return first.cfg;
}

export const box = (t: string): string => `mcp__box__${t}`;
