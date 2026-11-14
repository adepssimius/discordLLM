import type { Classification, ToolCall } from "../definition.js";

/**
 * The approval ladder.
 *
 * A bot names its tiers least to most dangerous — `read, write, destructive`,
 * or `read, control, change, destructive`. The approval level is the lowest
 * tier that waits for a person; `none` means nothing waits. The first tier
 * only looks, and never waits whatever the level says.
 *
 * Pure, so every rule is unit tested.
 */

export const NO_APPROVAL = "none";

/** The values an approval level may take for this ladder. */
export function approvalLevels(tiers: readonly string[]): string[] {
  return [...tiers.slice(1), NO_APPROVAL];
}

/** The default: only the top tier waits. With no ladder, nothing does. */
export function defaultApprovalLevel(tiers: readonly string[]): string {
  return tiers.length > 1 ? (tiers[tiers.length - 1] ?? NO_APPROVAL) : NO_APPROVAL;
}

/** Whether a call in this tier waits for a person at this approval level. */
export function needsApproval(tiers: readonly string[], tier: string, level: string): boolean {
  const t = tiers.indexOf(tier);
  // A tier the ladder has never heard of is a classifier bug. Ask.
  if (t === -1) return true;
  if (t === 0 || level === NO_APPROVAL) return false;
  const at = tiers.indexOf(level);
  return at !== -1 && t >= at;
}

export function isReadTier(tiers: readonly string[], tier: string): boolean {
  return tiers.length > 0 && tiers[0] === tier;
}

/** The top of the ladder. "Approve the rest of this reply" never covers it. */
export function isTopTier(tiers: readonly string[], tier: string): boolean {
  return tiers.length > 1 && tiers[tiers.length - 1] === tier;
}

export const DEFAULT_TIERS = ["read", "write", "destructive"] as const;

const READ_PREFIXES = ["get_", "list_", "search_", "find_", "read_", "describe_", "show_", "query_", "count_", "lookup_", "fetch_", "view_", "check_"];
const DESTRUCTIVE_PREFIXES = ["delete_", "remove_", "purge_", "wipe_", "destroy_", "drop_", "reset_", "uninstall_"];

export interface NameRules {
  /** Tools that only look, by bare name, where the name alone does not say so. */
  readonly read?: readonly string[];
  /** Tools that count as destructive whatever their name. */
  readonly destructive?: readonly string[];
  readonly readPrefixes?: readonly string[];
  readonly destructivePrefixes?: readonly string[];
}

/**
 * A classifier over the three default tiers that goes by tool name alone.
 *
 * It fails toward asking: a tool whose name says nothing is a `write`. Good
 * enough to put a new MCP server behind approval on day one; a bot whose
 * tools take an `action` argument, or whose risk depends on what is being
 * acted on, writes its own.
 */
export function classifyByName(servers: readonly string[], rules: NameRules = {}) {
  const read = new Set(rules.read ?? []);
  const destructive = new Set(rules.destructive ?? []);
  const readPrefixes = rules.readPrefixes ?? READ_PREFIXES;
  const destructivePrefixes = rules.destructivePrefixes ?? DESTRUCTIVE_PREFIXES;
  const gated = new Set(servers);

  return (call: ToolCall): Classification | undefined => {
    if (call.server === null || !gated.has(call.server)) return undefined;
    const t = call.tool;
    if (destructive.has(t)) return { tier: "destructive", reason: `${t} is marked destructive` };
    if (read.has(t)) return { tier: "read", reason: "only reads" };
    if (destructivePrefixes.some((p) => t.startsWith(p))) return { tier: "destructive", reason: `${t} deletes` };
    if (readPrefixes.some((p) => t.startsWith(p))) return { tier: "read", reason: "only reads" };
    return { tier: "write", reason: `${t} makes a change` };
  };
}
