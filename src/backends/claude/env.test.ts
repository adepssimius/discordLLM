import { describe, expect, it } from "vitest";
import { claudeAgent } from "./index.js";
import { agentEnv, credentialSource } from "./env.js";

describe("the agent's environment", () => {
  const parent = {
    PATH: "/bin",
    HOME: "/data/home",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    DISCORD_BOT_TOKEN: "discord-secret",
    BOX_TOKEN: "box-secret",
    DATABASE_URL: "postgres://u:db-secret@db/x",
  };

  it("never carries the Discord token, a server's token or the database URL", () => {
    const all = JSON.stringify(agentEnv({ timeZone: "UTC" }, parent));
    expect(all).not.toContain("discord-secret");
    expect(all).not.toContain("box-secret");
    expect(all).not.toContain("db-secret");
  });

  it("carries the credential the subprocess needs, HOME for its transcripts, and the time zone", () => {
    expect(agentEnv({ timeZone: "America/New_York" }, parent)).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      HOME: "/data/home",
      TZ: "America/New_York",
      PATH: "/bin",
    });
  });

  it("carries what the bot adds explicitly", () => {
    expect(agentEnv({ timeZone: "UTC", extra: { GIT_TERMINAL_PROMPT: "0" } }, parent).GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("hands over everything only when told to, for development", () => {
    expect(agentEnv({ timeZone: "UTC" }, { ...parent, AGENT_INHERIT_ENV: "true" }).DISCORD_BOT_TOKEN).toBe("discord-secret");
  });
});

describe("credentials", () => {
  it("are found in the SDK's own order", () => {
    expect(credentialSource({ CLAUDE_CODE_OAUTH_TOKEN: "a", ANTHROPIC_API_KEY: "b" })).toBe("oauth-token");
    expect(credentialSource({ ANTHROPIC_API_KEY: "b" })).toBe("api-key");
    expect(credentialSource({ CLAUDE_CODE_OAUTH_TOKEN: "  " })).toBe("none");
  });

  it("decide whether the backend is ready, and say what to set when it is not", () => {
    const backend = claudeAgent();
    expect(backend.ready({ ANTHROPIC_API_KEY: "k" })).toEqual({ ok: true, source: "api-key" });
    expect(backend.ready({})).toMatchObject({ ok: false, problem: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN") });
    expect(backend.ready({ AGENT_INHERIT_ENV: "true" })).toMatchObject({ ok: true, warning: expect.stringContaining("dev only") });
  });

  it("are kept out of the logs", () => {
    expect(claudeAgent().secrets).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]));
  });
});
