import type { Logger } from "../logger.js";
import { toolCall, type Decision } from "../definition.js";
import type { ApprovalEvent, Approver } from "./approval.js";
import type { Authorization, ToolGuard } from "./backend.js";
import { evaluate, type PolicyRules } from "./policy.js";
import { needsApproval } from "./tiers.js";

/**
 * What every tool call goes through, whichever model is asking.
 *
 * In order:
 *  1. the synchronous policy (agent/policy.ts, then the bot's own rules) — a
 *     refusal there is final;
 *  2. a call the bot classifies into a tier that needs approval at this
 *     profile's level waits for the approver;
 *  3. everything else is allowed.
 *
 * The backend calls `authorize` before a tool runs. `check` is the first step
 * alone, for a backend with a synchronous hook that sees calls earlier — it is
 * also where the audit of every call is recorded, so it is called exactly once
 * per call by whichever of the two the backend reaches first.
 */

export interface GuardContext {
  readonly log: Logger;
  readonly rules: PolicyRules;
  readonly workDir: string;
  /** False for a scheduled run: nothing above the first tier. */
  readonly interactive: boolean;
  /** One of the bot's tiers, or `none`. */
  readonly approvalLevel: string;
  /** Who to ask. Absent means nobody can be asked, and anything needing approval is refused. */
  readonly approver?: Approver | undefined;
  /** Consulted per call so a `stop` in Discord takes effect mid-run. */
  readonly isAborted?: (() => boolean) | undefined;
  /** Every call, once, with the policy's verdict. The audit. */
  readonly onDecision?: ((e: GuardEvent) => void) | undefined;
  readonly onApproval?: ((e: ApprovalEvent) => void) | undefined;
}

export interface GuardEvent {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly decision: Decision;
}

export function createGuard(ctx: GuardContext): ToolGuard {
  const { log, rules } = ctx;

  const policy = (toolName: string, input: unknown): Decision =>
    evaluate(rules, {
      toolName,
      toolInput: input,
      workDir: ctx.workDir,
      interactive: ctx.interactive,
      ...(ctx.isAborted ? { aborted: ctx.isAborted() } : {}),
    });

  const tierOf = (toolName: string, input: unknown) => {
    const c = rules.classify?.(toolCall(toolName, input));
    return c && needsApproval(rules.tiers, c.tier, ctx.approvalLevel) ? c : undefined;
  };

  // A backend may reach `check` and then `authorize` for the same call, or
  // only `authorize`. The audit wants each call once.
  const audited = new WeakSet<object>();
  const audit = (toolName: string, input: unknown, decision: Decision): void => {
    if (input !== null && typeof input === "object") {
      if (audited.has(input)) return;
      audited.add(input);
    }
    ctx.onDecision?.({ toolName, toolInput: input, decision });
  };

  return {
    check(toolName, input) {
      const decision = policy(toolName, input);
      audit(toolName, input, decision);
      if (!decision.allow) {
        log.warn({ tool: toolName, reason: decision.reason }, "tool denied by policy");
        return { decision, needsApproval: false };
      }
      // Only an interactive run can ask; a scheduled one was already refused
      // anything above the first tier by the policy.
      const c = ctx.interactive ? tierOf(toolName, input) : undefined;
      return c ? { decision, needsApproval: true, why: c.reason } : { decision, needsApproval: false };
    },

    async authorize(toolName, input, o): Promise<Authorization> {
      const decision = policy(toolName, input);
      audit(toolName, input, decision);
      if (!decision.allow) {
        log.warn({ tool: toolName, reason: decision.reason }, "tool call refused");
        return { allow: false, message: decision.reason };
      }

      const c = tierOf(toolName, input);
      if (c) {
        const req = { toolName, input, tier: c.tier, reason: c.reason, toolUseId: o.toolUseId };
        const answer = ctx.approver
          ? await ctx.approver(req, o.signal)
          : { approved: false as const, by: null, reason: "there is nobody here to approve it" };
        ctx.onApproval?.({ ...req, answer });
        log.info({ tool: toolName, tier: c.tier, approved: answer.approved, by: answer.by }, "approval answered");
        if (!answer.approved) {
          return {
            allow: false,
            message:
              `Not done: ${answer.reason}. Nothing was changed. Tell the person what you were going to do, ` +
              "and do not try to get the same effect another way.",
          };
        }
        return { allow: true };
      }

      // Every ordinary call lands here too, so only the ones the backend
      // flagged as sensitive are worth a line at info.
      log[o.flagged ? "info" : "debug"]({ tool: toolName, why: o.flagged }, "tool call allowed");
      return { allow: true };
    },
  };
}
