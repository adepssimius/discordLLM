import { describe, expect, it } from "vitest";
import { config } from "../../test/kit.js";
import { inspectorAuthz } from "./approvals.js";
import { checkActor } from "./authz.js";

const may = (env: Record<string, string>, userId: string, roleIds: string[] = []): boolean | null => {
  const authz = inspectorAuthz(config(env));
  return authz ? checkActor(authz, { userId, roleIds }).allowed : null;
};

describe("who may ask for the prompt", () => {
  it("is whoever may approve, when nothing more is said", () => {
    const env = { DISCORD_CHAT_USER_IDS: "1,2", DISCORD_APPROVER_USER_IDS: "1" };
    expect(may(env, "1")).toBe(true);
    expect(may(env, "2")).toBe(false);
  });

  it("falls back to whoever may chat, when there are no approver lists either", () => {
    expect(may({ DISCORD_CHAT_CHANNEL_IDS: "100" }, "7")).toBe(true);
    expect(may({ DISCORD_CHAT_USER_IDS: "1" }, "7")).toBe(false);
  });

  it("is its own list when one is given, by user or by role", () => {
    const env = { DISCORD_CHAT_CHANNEL_IDS: "100", DISCORD_APPROVER_USER_IDS: "1", DISCORD_PROMPT_USER_IDS: "5", DISCORD_PROMPT_ROLE_IDS: "900" };
    expect(may(env, "5")).toBe(true);
    expect(may(env, "6", ["900"])).toBe(true);
    // An approver who is not on the list does not get it.
    expect(may(env, "1")).toBe(false);
  });

  it("is nobody when switched off, whatever the lists say", () => {
    expect(may({ PROMPT_INSPECTION: "false", DISCORD_PROMPT_USER_IDS: "5" }, "5")).toBeNull();
  });
});
