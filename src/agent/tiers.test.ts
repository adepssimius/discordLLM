import { describe, expect, it } from "vitest";
import { toolCall } from "../definition.js";
import { approvalLevels, classifyByName, defaultApprovalLevel, isReadTier, isTopTier, needsApproval } from "./tiers.js";

const three = ["read", "write", "destructive"];
const four = ["read", "control", "change", "destructive"];

describe("the ladder", () => {
  it("offers every tier above the first, and none, as approval levels", () => {
    expect(approvalLevels(three)).toEqual(["write", "destructive", "none"]);
    expect(approvalLevels(four)).toEqual(["control", "change", "destructive", "none"]);
    expect(approvalLevels([])).toEqual(["none"]);
  });

  it("defaults to asking only at the top", () => {
    expect(defaultApprovalLevel(three)).toBe("destructive");
    expect(defaultApprovalLevel([])).toBe("none");
  });

  it("asks at the level and everything above it", () => {
    expect(four.map((t) => needsApproval(four, t, "change"))).toEqual([false, false, true, true]);
    expect(four.map((t) => needsApproval(four, t, "control"))).toEqual([false, true, true, true]);
    expect(four.map((t) => needsApproval(four, t, "none"))).toEqual([false, false, false, false]);
  });

  it("never asks about the tier that only looks", () => {
    for (const level of approvalLevels(three)) expect(needsApproval(three, "read", level)).toBe(false);
  });

  it("asks about a tier it has never heard of, even at none", () => {
    expect(needsApproval(three, "mystery", "none")).toBe(true);
  });

  it("knows its ends", () => {
    expect(isReadTier(three, "read")).toBe(true);
    expect(isTopTier(three, "destructive")).toBe(true);
    expect(isTopTier(three, "write")).toBe(false);
    expect(isTopTier(["read"], "read")).toBe(false);
  });
});

describe("classifyByName", () => {
  const c = classifyByName(["box"], { read: ["inventory_stats"], destructive: ["import_csv"] });
  const tier = (name: string): string | undefined => c(toolCall(name, {}))?.tier;

  it("goes by the verb", () => {
    expect(tier("mcp__box__get_item")).toBe("read");
    expect(tier("mcp__box__list_tags")).toBe("read");
    expect(tier("mcp__box__delete_item")).toBe("destructive");
  });

  it("takes corrections", () => {
    expect(tier("mcp__box__inventory_stats")).toBe("read");
    expect(tier("mcp__box__import_csv")).toBe("destructive");
  });

  it("fails toward asking: a name that says nothing is a write", () => {
    expect(tier("mcp__box__reticulate_splines")).toBe("write");
  });

  it("says nothing about tools that are not its servers'", () => {
    expect(tier("Read")).toBeUndefined();
    expect(tier("mcp__bot__poll")).toBeUndefined();
    expect(tier("mcp__other__delete_all")).toBeUndefined();
  });
});
