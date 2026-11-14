import { describe, expect, it } from "vitest";
import { buildCard, outcomeLine, renderDetail, summarizeCall, tierLook, type CardStyle } from "./approvalCard.js";

const style: CardStyle = {
  tiers: ["read", "write", "destructive"],
  tierLabels: { write: "Change" },
  describe: (c) => (c.tool === "delete_item" ? `Delete item “${String((c.input as { identifier?: string }).identifier)}”` : undefined),
};
const DEL = "mcp__box__delete_item";

describe("summarizeCall", () => {
  it("uses the bot's own line when it has one", () => {
    expect(summarizeCall(style, DEL, { identifier: "Old drill" })).toBe("Delete item “Old drill”");
  });

  it("falls back to the tool name in words", () => {
    expect(summarizeCall(style, "mcp__box__reticulate_splines", {})).toBe("Reticulate splines");
    expect(summarizeCall({ tiers: [] }, DEL, {})).toBe("Delete item");
  });
});

describe("renderDetail", () => {
  it("cannot be broken out of its code fence", () => {
    const d = renderDetail({ yaml: "```\n@everyone" });
    expect(d.match(/```/g)).toHaveLength(2);
  });

  it("clips very large inputs", () => {
    expect(renderDetail({ big: "x".repeat(10_000) }).length).toBeLessThan(3700);
  });
});

describe("buildCard", () => {
  const base = { toolName: DEL, input: {}, reason: "r", toolUseId: "t" };

  it("never offers approve-the-rest at the top of the ladder", () => {
    expect(buildCard(style, { ...base, tier: "write" }).offerApproveRest).toBe(true);
    expect(buildCard(style, { ...base, tier: "destructive" }).offerApproveRest).toBe(false);
  });

  it("titles the card with the tier's label", () => {
    expect(buildCard(style, { ...base, tier: "write" }).title).toBe("Change — needs approval");
    expect(buildCard(style, { ...base, tier: "destructive" }).title).toBe("Destructive — needs approval");
  });

  it("colours a four-step ladder grey, amber, amber, red", () => {
    const four: CardStyle = { tiers: ["read", "control", "change", "destructive"] };
    const colors = four.tiers.map((t) => tierLook(four, t).color);
    expect(colors[0]).not.toBe(colors[1]);
    expect(colors[1]).toBe(colors[2]);
    expect(colors[3]).not.toBe(colors[2]);
  });
});

describe("outcomeLine", () => {
  it("says who decided", () => {
    expect(outcomeLine({ kind: "approved", by: "42" })).toBe("✅ Approved by <@42>");
    expect(outcomeLine({ kind: "denied", by: "42" })).toBe("🚫 Denied by <@42>");
    expect(outcomeLine({ kind: "timeout", minutes: 15 })).toMatch(/15 min — not done/);
  });
});
