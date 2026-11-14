/**
 * A tool call waiting for a person. The bot turns this into a message with
 * Approve / Deny buttons in the thread (discord/approvals.ts); the dev REPL
 * answers from an environment variable.
 */
export interface ApprovalRequest {
  readonly toolName: string;
  readonly input: unknown;
  /** One of the bot's tiers. */
  readonly tier: string;
  /** Why it needs asking, from the bot's classifier. */
  readonly reason: string;
  readonly toolUseId: string;
}

export type ApprovalAnswer =
  | { readonly approved: true; readonly by: string }
  | { readonly approved: false; readonly by: string | null; readonly reason: string };

/**
 * Asks, and resolves when someone answers, the request times out, or the run
 * is stopped (the signal). Never rejects: a failure to ask is a refusal.
 */
export type Approver = (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;

/** One line per decision, for the audit table. */
export interface ApprovalEvent extends ApprovalRequest {
  readonly answer: ApprovalAnswer;
}
