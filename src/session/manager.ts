import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { BotDefinition, Domain } from "../definition.js";
import type { Logger } from "../logger.js";
import type { Approver } from "../agent/approval.js";
import type { AgentBackend, AgentOutcome, AgentSink, RateLimitInfo } from "../agent/backend.js";
import { createGuard } from "../agent/guard.js";
import type { PolicyRules } from "../agent/policy.js";
import {
  BOT_SERVER,
  BRIEF_ONLY_LOOKS,
  briefUserPrompt,
  chatUserPrompt,
  localStamp,
  stripTurnHeader,
  type ChatMessageContext,
  type TurnContext,
} from "../agent/prompts.js";
import { prepareImages, type ImageBlock } from "../agent/images.js";
import { explainVerdict, type QuotaGuard } from "../quota/budget.js";
import type { Store } from "../store/index.js";
import { botTools, POLLS_PER_TURN } from "../tools/bot.js";
import { filesSince, type WorkspaceProvider } from "../workspace.js";
import type { NewToolCall, PollRequest, PostedFile, Schedule, Session, TurnTrigger } from "./types.js";

/**
 * Owns the commit protocol for one profile. Nothing else writes session or
 * turn state.
 *
 * Ordering (each step is what makes the next one recoverable):
 *   1. the Discord message or thread exists, then the session row
 *   2. the session's working directory exists
 *   3. turn row + session running, atomically, BEFORE any token is spent
 *   4. tool-call and approval audit streams in
 *   5. terminal turn state + session counters, atomically
 *   6. caller delivers to Discord and records the message id
 *
 * What makes a thread survive a restart is its row here, its working
 * directory, and the backend's own record of the conversation. Lose that
 * record and the turn still runs, from a short recap.
 */

export interface ManagerDeps {
  /** Shared settings plus this manager's profile. One manager per profile. */
  readonly cfg: Config;
  readonly log: Logger;
  readonly store: Store;
  readonly def: Pick<BotDefinition, "tiers" | "shell" | "skills" | "botServer" | "attachments">;
  /** The model. Everything this class knows about it is the AgentBackend interface. */
  readonly backend: AgentBackend;
  readonly domain: Domain;
  readonly workspace: WorkspaceProvider;
  /** Omit to run unmetered — dev only. */
  readonly quota?: QuotaGuard;
}

export interface TurnRan {
  readonly blocked: false;
  readonly turnId: number;
  readonly ok: boolean;
  readonly text: string;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly deniedTools: number;
  /** True when the SDK transcript was gone and context was rebuilt from the store. */
  readonly contextRebuilt: boolean;
  /** True when this turn had to create the working directory. */
  readonly workspaceCreated: boolean;
  /** Polls the agent asked for. The caller posts them after delivering the reply. */
  readonly polls: readonly PollRequest[];
  /** Absolute paths of files generated during the turn (Domain.postFilesFrom), for the bot to post. */
  readonly generated: readonly string[];
  readonly rateLimit?: RateLimitInfo;
}

/** Refused before anything was sent to the model. No turn row, no spend. */
export interface TurnBlocked {
  readonly blocked: true;
  readonly message: string;
}

export type TurnResult = TurnRan | TurnBlocked;

interface ExecuteRequest {
  readonly session: Session;
  readonly trigger: TurnTrigger;
  readonly actorId: string | null;
  readonly buildPrompt: (turn: TurnContext, dir: string) => Promise<{ text: string; images?: readonly ImageBlock[] }>;
  /** False for a scheduled run: nothing above the first tier, no scheduling tools. */
  readonly interactive: boolean;
  readonly approver?: Approver | undefined;
}

const TOOL_FLUSH_EVERY = 10;

export class SessionManager {
  private readonly aborted = new Set<string>();
  private runScheduleNow: ((s: Schedule) => void) | undefined;
  private readonly rules: PolicyRules;
  private readonly botServerName: string;

  constructor(private readonly deps: ManagerDeps) {
    const { def, domain } = deps;
    const shell = def.shell === true;
    this.rules = {
      tiers: def.tiers ?? [],
      shell,
      confineReads: !shell,
      classify: domain.classify ? (c) => domain.classify?.(c) : undefined,
      policy: domain.policy ? (c) => domain.policy!(c) : undefined,
    };
    this.botServerName = def.botServer ?? BOT_SERVER;
  }

  /** Wired by the bot once it can post to a channel. */
  onRunScheduleNow(fn: (s: Schedule) => void): void {
    this.runScheduleNow = fn;
  }

  /** Whose conversations this manager runs. */
  get profile(): string {
    return this.deps.cfg.name;
  }

  get policyRules(): PolicyRules {
    return this.rules;
  }

  /** Step 1 for chat. The caller must have created the Discord thread already. */
  async openChat(input: {
    guildId: string;
    channelId: string;
    threadId: string;
    openedBy: string | null;
    title: string;
  }): Promise<Session> {
    const existing = await this.deps.store.sessions.byThread(input.threadId);
    if (existing) return existing;
    return this.create("chat", { ...input, scheduleId: null });
  }

  /**
   * Step 1 for a scheduled brief. `anchorId` is the id of the message already
   * posted to the channel — and the id any thread started from it will have.
   */
  openBrief(input: { guildId: string; channelId: string; anchorId: string; schedule: Schedule }): Promise<Session> {
    const day = localStamp(new Date(), this.deps.cfg.BOT_TIMEZONE).split(" ")[1] ?? "";
    return this.create("brief", {
      guildId: input.guildId,
      channelId: input.channelId,
      threadId: input.anchorId,
      openedBy: null,
      title: `${input.schedule.name} ${day}`.trim(),
      scheduleId: input.schedule.id,
    });
  }

  private create(
    kind: Session["kind"],
    input: {
      guildId: string;
      channelId: string;
      threadId: string;
      openedBy: string | null;
      title: string;
      scheduleId: number | null;
    },
  ): Promise<Session> {
    const { cfg, store, domain } = this.deps;
    const id = randomUUID();
    const title = input.title.slice(0, 100);
    return store.sessions.create({
      id,
      profile: cfg.name,
      kind,
      guildId: input.guildId,
      channelId: input.channelId,
      threadId: input.threadId,
      // Generated here, so it is durable before the agent subprocess exists.
      agentSessionId: randomUUID(),
      openedBy: input.openedBy,
      title,
      branch: domain.refFor?.({ id, title, kind }) ?? "",
      scheduleId: input.scheduleId,
    });
  }

  abort(sessionId: string): void {
    this.aborted.add(sessionId);
  }

  clearAbort(sessionId: string): void {
    this.aborted.delete(sessionId);
  }

  isAborted(sessionId: string): boolean {
    return this.aborted.has(sessionId);
  }

  /** Decides whether the stored conversation can actually be resumed. */
  private async resolveResume(session: Session, dir: string): Promise<string | null> {
    if (!session.agentSessionId) return null;
    // Asked even on a first turn: a turn that was cut off by a restart leaves a
    // transcript behind without ever having been counted, and resuming it
    // keeps whatever the agent had already worked out.
    return (await this.deps.backend.canResume(session.agentSessionId, dir).catch(() => false)) ? session.agentSessionId : null;
  }

  /** Rebuilds enough context to continue usefully when the transcript is gone. */
  private async recapPrefix(sessionId: string): Promise<string> {
    const turns = await this.deps.store.turns.recent(sessionId, 4);
    if (turns.length === 0) return "";
    const lines = [
      "## Earlier in this thread",
      "",
      "Your own record of this conversation was lost. This recap comes from the bot's log of it.",
      "",
    ];
    for (const t of turns) {
      lines.push(`- They wrote: ${stripTurnHeader(t.prompt).slice(0, 400)}`);
      lines.push(`  You answered: ${(t.result ?? "").slice(0, 600)}`);
    }
    lines.push("", "---", "");
    return lines.join("\n");
  }

  async runChatTurn(
    req: {
      session: Session;
      trigger: TurnTrigger;
      actorId: string | null;
      message: ChatMessageContext;
      files?: readonly PostedFile[];
      skippedFiles?: readonly string[];
      approver?: Approver | undefined;
    },
    sink: AgentSink = {},
  ): Promise<TurnResult> {
    const files = req.files ?? [];
    return this.execute(
      {
        session: req.session,
        trigger: req.trigger,
        actorId: req.actorId,
        buildPrompt: async (turn, dir) => {
          if (files.length === 0 && (req.skippedFiles ?? []).length === 0) {
            return { text: chatUserPrompt(req.message, turn) };
          }
          const prepared = await prepareImages(dir, files);
          this.deps.log.info(
            { sessionId: req.session.id, files: files.length, shown: prepared.shown.size },
            "posted files prepared",
          );
          const message: ChatMessageContext = {
            ...req.message,
            files,
            shown: prepared.shown,
            ...(req.skippedFiles && req.skippedFiles.length > 0 ? { skippedFiles: req.skippedFiles } : {}),
          };
          return { text: chatUserPrompt(message, turn), images: prepared.blocks };
        },
        // A brief that someone continued in a thread is a conversation like
        // any other from then on: a person is there to approve.
        interactive: true,
        approver: req.approver,
      },
      sink,
    );
  }

  async runBriefTurn(session: Session, schedule: Schedule, sink: AgentSink = {}): Promise<TurnResult> {
    const { def, domain } = this.deps;
    const note = domain.briefNote ?? ((def.tiers ?? []).length > 1 ? BRIEF_ONLY_LOOKS : undefined);
    return this.execute(
      {
        session,
        trigger: "schedule",
        actorId: null,
        buildPrompt: async (turn) => ({ text: briefUserPrompt(schedule, turn, note) }),
        interactive: false,
      },
      sink,
    );
  }

  private async execute(req: ExecuteRequest, sink: AgentSink): Promise<TurnResult> {
    const { cfg, log, store, quota, def, domain, workspace, backend } = this.deps;
    const session = req.session;

    // Before anything else: refusing here means no turn row, no subprocess, and
    // nothing for restart recovery to reconcile.
    if (quota) {
      const verdict = await quota.check();
      if (!verdict.allowed) {
        log.warn({ sessionId: session.id, reason: verdict.reason }, "turn refused by quota guard");
        return { blocked: true, message: explainVerdict(verdict) };
      }
    }

    // Step 2. Without a directory there is nothing for the agent to stand in.
    let dir: string;
    let workspaceCreated: boolean;
    try {
      const ws = await workspace.ensure(session);
      dir = ws.dir;
      workspaceCreated = ws.created;
    } catch (e) {
      log.error({ err: e, sessionId: session.id }, "could not prepare the workspace");
      return {
        blocked: true,
        message:
          `I couldn't prepare the working directory for this thread: ${e instanceof Error ? e.message : String(e)}\n` +
          "Nothing was sent to the model.",
      };
    }

    const botTool = (name: string): string => `mcp__${this.botServerName}__${name}`;
    let own;
    try {
      own = await domain.turn({
        session,
        dir,
        dirCreated: workspaceCreated,
        interactive: req.interactive,
        actorId: req.actorId,
        timeZone: cfg.BOT_TIMEZONE,
        approvalLevel: cfg.APPROVAL_LEVEL,
        botTool,
      });
    } catch (e) {
      log.error({ err: e, sessionId: session.id }, "the bot could not set up the turn");
      return {
        blocked: true,
        message: `I couldn't get ready for this turn: ${e instanceof Error ? e.message : String(e)}\nNothing was sent to the model.`,
      };
    }

    const resume = await this.resolveResume(session, dir);
    const contextRebuilt = session.turnCount > 0 && resume === null;
    if (contextRebuilt) {
      log.warn({ sessionId: session.id }, "conversation record unavailable — rebuilding context from the store");
    }

    const turn: TurnContext = { now: new Date(), timeZone: cfg.BOT_TIMEZONE, extraLines: own.headerLines };
    const built = await req.buildPrompt(turn, dir);
    const prompt = (contextRebuilt ? await this.recapPrefix(session.id) : "") + built.text;

    // Step 3 — durable before a token is spent.
    const turnId = await store.turns.begin({
      sessionId: session.id,
      trigger: req.trigger,
      actorId: req.actorId,
      prompt,
      resumedFrom: resume,
    });

    // A fresh SDK session needs an id we own; a continuing one needs `resume`.
    const freshId = resume ? null : randomUUID();
    if (freshId) await store.sessions.setAgentSession(session.id, freshId);

    const pending: NewToolCall[] = [];
    const polls: PollRequest[] = [];
    let denied = 0;
    let rateLimit: RateLimitInfo | undefined;
    // Audit writes are fired from synchronous callbacks; this keeps them in
    // order and lets the turn wait for the last of them before it is closed.
    let audit: Promise<void> = Promise.resolve();
    const record = (what: string, fn: () => Promise<void>): void => {
      audit = audit.then(fn).catch((e: unknown) => log.error({ err: e }, what));
    };

    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      record("failed to persist tool audit batch", () => store.turns.recordToolCalls(batch));
    };

    const guard = createGuard({
      log,
      rules: this.rules,
      workDir: dir,
      interactive: req.interactive,
      approvalLevel: cfg.APPROVAL_LEVEL,
      approver: req.approver,
      isAborted: () => this.aborted.has(session.id),
      onDecision: (e) => {
        if (!e.decision.allow) denied += 1;
        pending.push({
          turnId,
          sessionId: session.id,
          toolName: e.toolName,
          inputJson: JSON.stringify(e.toolInput ?? null).slice(0, 4000),
          allowed: e.decision.allow,
          denyReason: e.decision.allow ? null : e.decision.reason,
        });
        if (pending.length >= TOOL_FLUSH_EVERY) flush();
      },
      onApproval: (e) => {
        if (!e.answer.approved) denied += 1;
        record("failed to record an approval", () =>
          store.turns.recordApproval({
            turnId,
            sessionId: session.id,
            toolName: e.toolName,
            inputJson: JSON.stringify(e.input ?? null).slice(0, 4000),
            tier: e.tier,
            reason: e.reason,
            approved: e.answer.approved,
            answeredBy: e.answer.by,
            denyReason: e.answer.approved ? null : e.answer.reason,
          }),
        );
      },
    });

    const chunks: string[] = [];
    const run = (): Promise<AgentOutcome> =>
      backend
        .run(
          {
            workDir: dir,
            systemPrompt: own.systemPrompt,
            prompt: { text: prompt, ...(built.images && built.images.length > 0 ? { images: built.images } : {}) },
            ...(resume ? { resume } : { sessionId: freshId! }),
            title: session.title,
            servers: domain.servers,
            toolServer: this.botServerName,
            tools: botTools({
              cfg,
              store,
              serverName: this.botServerName,
              actorId: req.actorId,
              interactive: req.interactive,
              // Only a real Discord id: the dev REPL's "repl" channel is not one.
              defaultChannelId: /^\d{5,25}$/.test(session.channelId) ? session.channelId : undefined,
              requestPoll: (p) => {
                if (polls.length >= POLLS_PER_TURN) return false;
                polls.push(p);
                return true;
              },
              runScheduleNow: this.runScheduleNow,
              extraTools: own.tools,
            }),
            builtinTools: cfg.AGENT_BUILTIN_TOOLS,
            shell: this.rules.shell,
            skills: def.skills === true,
            guard,
            env: domain.agentEnv ?? {},
            timeZone: cfg.BOT_TIMEZONE,
            model: cfg.AGENT_MODEL,
            maxTurns: cfg.AGENT_MAX_TURNS,
            shouldStop: () => this.aborted.has(session.id),
          },
          {
            ...sink,
            onText: (t) => {
              chunks.push(t);
              sink.onText?.(t);
            },
            onRateLimit: (info) => {
              rateLimit = info;
              // Feed the guard first: it may set a cooldown that refuses the
              // *next* run before anything is spent on it.
              void quota?.onRateLimit(info).catch((e: unknown) => log.error({ err: e }, "quota guard failed on a rate-limit event"));
              sink.onRateLimit?.(info);
            },
          },
        )
        // The contract says a backend does not throw. One that does is still an outcome.
        .catch((e: unknown): AgentOutcome => ({
          ok: false,
          sessionId: undefined,
          error: e instanceof Error ? e.message : String(e),
          exhaustedTurns: false,
          numTurns: 0,
          costUsd: 0,
        }));

    const startedAt = Date.now();
    // The permit is held only around the model call, not the bookkeeping.
    const outcome = quota ? await quota.semaphore.run(run) : await run();

    flush();
    await audit;

    // Keep our record of the SDK session honest if it reported a different id.
    if (outcome.sessionId && outcome.sessionId !== (resume ?? freshId)) {
      log.warn(
        { expected: resume ?? freshId, actual: outcome.sessionId },
        "agent reported a different session id than requested",
      );
      await store.sessions.setAgentSession(session.id, outcome.sessionId);
    }

    const text = replyText(chunks, outcome.ok ? outcome.result : "");
    const wasAborted = this.aborted.has(session.id);

    // Step 5 — turn state and session counters move together.
    await store.turns.finish(turnId, {
      status: outcome.ok ? "ok" : wasAborted ? "aborted" : "error",
      result: text || null,
      error: outcome.ok ? null : outcome.error,
      errorSubtype: outcome.ok ? null : (outcome.subtype ?? null),
      numTurns: outcome.numTurns,
      costUsd: outcome.costUsd,
      deniedToolCount: denied,
    });

    this.clearAbort(session.id);

    const generated: string[] = [];
    for (const d of domain.postFilesFrom ?? []) generated.push(...(await filesSince(d, startedAt)));

    return {
      blocked: false,
      turnId,
      ok: outcome.ok,
      text: outcome.ok ? text : `${describeFailure(outcome.error, wasAborted)}${text ? `\n\n${text}` : ""}`,
      numTurns: outcome.numTurns,
      costUsd: outcome.costUsd,
      deniedTools: denied,
      contextRebuilt,
      workspaceCreated,
      // A run that failed part-way may have queued a poll about work it never
      // finished; asking the person about that would be noise.
      polls: outcome.ok ? polls : [],
      generated,
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  /** Step 6 bookkeeping, once the caller has delivered the answer. */
  async markDelivered(turnId: number, messageId: string): Promise<void> {
    await this.deps.store.turns.setDiscordMessage(turnId, messageId);
  }
}

/**
 * Boot recovery, across every profile. Interrupted turns are never retried
 * automatically: the question may be stale, and replaying a half-finished
 * change is the last thing anyone wants after a restart. The sessions are
 * returned so the bot can say so in each thread instead of leaving a question
 * hanging.
 */
export async function recoverInterrupted(store: Store, log: Logger): Promise<{ interrupted: readonly Session[] }> {
  const orphans = await store.turns.running();
  await store.turns.markInterrupted(orphans.map((t) => t.id));
  const reset = await store.sessions.resetRunning();

  const sessions: Session[] = [];
  for (const id of new Set(orphans.map((t) => t.sessionId))) {
    const s = await store.sessions.byId(id);
    if (s) sessions.push(s);
  }

  if (orphans.length > 0) {
    log.warn({ interrupted: orphans.length, sessionsReset: reset }, "recovered from an unclean shutdown");
  }
  return { interrupted: sessions };
}

/**
 * The reply, made of everything the agent wrote this turn, in order.
 *
 * Not the SDK's `result`: that is only the final text block. An agent that
 * answers, then tidies up (updates its notes) and signs off with "Noted that
 * for next time" would otherwise deliver the sign-off and drop the answer —
 * which is exactly what happened in the first real thread. `result` is the
 * fallback for a run that produced no text blocks we saw.
 */
export function replyText(blocks: readonly string[], result: string): string {
  const parts = blocks.map((b) => b.trim()).filter((b) => b.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : result;
}

function describeFailure(error: string, aborted: boolean): string {
  if (aborted) return "_Stopped._";
  if (/error_max_turns/.test(error)) {
    return "_I ran out of steps before finishing. Tell me to continue and I'll pick up where I stopped._";
  }
  return `_The run failed: ${error}_`;
}
