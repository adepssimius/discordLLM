import type { ApprovalRequest } from "../agent/approval.js";
import { parseToolName, toolCall, type ToolCall } from "../definition.js";

/**
 * What an approval request looks like in Discord. Pure, so the wording is
 * unit tested; discord/approvals.ts turns it into an embed with buttons.
 *
 * The card has to be decidable on a phone in a few seconds: one line saying
 * what will happen, one saying why it is being asked, and the exact input
 * underneath for anyone who wants to check it.
 */

export interface Card {
  readonly title: string;
  readonly summary: string;
  readonly reason: string;
  /** The tool input, pretty-printed and clipped to fit an embed. */
  readonly detail: string;
  readonly color: number;
  /** Whether to offer "approve the rest of this reply". Never for the top tier. */
  readonly offerApproveRest: boolean;
}

/** How a bot's ladder shows on a card. */
export interface CardStyle {
  readonly tiers: readonly string[];
  readonly tierLabels?: Readonly<Record<string, string>> | undefined;
  /** The bot's one-line summary of a call; undefined falls back to the tool's name. */
  readonly describe?: ((call: ToolCall) => string | undefined) | undefined;
}

const GREY = 0x95a5a6;
const AMBER = 0xf39c12;
const RED = 0xe74c3c;

/** Grey for the tier that only looks, red for the top of the ladder, amber between. */
export function tierLook(style: CardStyle, tier: string): { label: string; color: number; top: boolean } {
  const i = style.tiers.indexOf(tier);
  const top = i !== -1 && i === style.tiers.length - 1 && style.tiers.length > 1;
  const color = i === 0 ? GREY : top || i === -1 ? RED : AMBER;
  const label = style.tierLabels?.[tier] ?? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
  return { label, color, top };
}

const MAX_DETAIL = 3500;

/** `set_warranty` → "Set warranty". */
export function plainSummary(toolName: string): string {
  const words = parseToolName(toolName).tool.replace(/[_-]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** One line saying what the call will do. */
export function summarizeCall(style: CardStyle, toolName: string, input: unknown): string {
  return style.describe?.(toolCall(toolName, input)) ?? plainSummary(toolName);
}

export function renderDetail(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input ?? null, null, 2);
  } catch {
    json = String(input);
  }
  // A literal fence in the input would close ours early.
  json = json.replace(/```/g, "ˋˋˋ");
  if (json.length > MAX_DETAIL) json = `${json.slice(0, MAX_DETAIL)}\n… (${json.length - MAX_DETAIL} more characters)`;
  return `\`\`\`json\n${json}\n\`\`\``;
}

export function buildCard(style: CardStyle, req: ApprovalRequest): Card {
  const look = tierLook(style, req.tier);
  return {
    title: `${look.label} — needs approval`,
    summary: summarizeCall(style, req.toolName, req.input),
    reason: req.reason,
    detail: renderDetail(req.input),
    color: look.color,
    offerApproveRest: !look.top && style.tiers.includes(req.tier),
  };
}

/** The line the card is left with once it is decided. */
export function outcomeLine(
  outcome:
    | { kind: "approved"; by: string; rest?: boolean }
    | { kind: "denied"; by: string }
    | { kind: "timeout"; minutes: number }
    | { kind: "stopped" },
): string {
  switch (outcome.kind) {
    case "approved":
      return outcome.rest
        ? `✅ Approved by <@${outcome.by}>, with the rest of this reply`
        : `✅ Approved by <@${outcome.by}>`;
    case "denied":
      return `🚫 Denied by <@${outcome.by}>`;
    case "timeout":
      return `⏱️ Nobody answered within ${outcome.minutes} min — not done`;
    case "stopped":
      return "🛑 Stopped — not done";
  }
}
