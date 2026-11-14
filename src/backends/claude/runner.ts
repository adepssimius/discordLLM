import { query, type Options, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentOutcome, AgentRun, AgentSink, RateLimitInfo } from "../../agent/backend.js";

type TurnInput = AgentRun["prompt"];
type RunOutcome = AgentOutcome;

/** The SDK's report, in the library's words. */
function neutral(info: SDKRateLimitInfo): RateLimitInfo {
  return {
    status: info.status,
    rateLimitType: info.rateLimitType,
    resetsAt: info.resetsAt,
    utilization: info.utilization,
  };
}

/**
 * A plain string when there is nothing but text — the path every turn took
 * before photos. With images, a one-message stream carrying the text first
 * and the images after it. The text leads deliberately: the SDK recognises a
 * resumable transcript by its first human-looking prompt.
 *
 * Ending the stream after one message is safe with canUseTool and hooks in
 * play: the SDK holds stdin open until the first result arrives.
 */
export function toPrompt(input: TurnInput): string | AsyncIterable<SDKUserMessage> {
  const images = input.images ?? [];
  if (images.length === 0) return input.text;
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text: input.text }, ...images.map((b) => ({ ...b, source: { ...b.source } }))],
    },
  };
  return (async function* () {
    yield message;
  })();
}

/**
 * Drives one query() to completion.
 *
 * Two details are load-bearing:
 *
 * - The session id is captured from the first `system/init` message and reported
 *   to the sink immediately, because a single-shot query() throws *after*
 *   yielding an error result. Losing the id would orphan the session and make
 *   resume impossible.
 * - Failures report `numTurns`/`costUsd` too. A run that dies on `error_max_turns`
 *   is the single most expensive thing this system can do, and accounting it as
 *   zero would let a budget check wave through the next one.
 */
export async function runQuery(
  input: TurnInput,
  options: Options,
  sink: AgentSink = {},
  shouldStop?: () => boolean,
): Promise<RunOutcome> {
  let sessionId: string | undefined;
  let rateLimit: RateLimitInfo | undefined;

  try {
    for await (const message of query({ prompt: toPrompt(input), options }) as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        sink.onSession?.(sessionId);
        continue;
      }

      if (message.type === "tool_use_summary") {
        sink.onToolSummary?.(message.summary, message.preceding_tool_use_ids);
        continue;
      }

      if (message.type === "rate_limit_event") {
        rateLimit = neutral(message.rate_limit_info);
        sink.onRateLimit?.(rateLimit);
        continue;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") sink.onText?.(block.text);
          else if (block.type === "tool_use") sink.onToolUse?.(block.name, block.input, block.id);
          else if (block.type === "thinking") sink.onThinking?.();
        }
        if (shouldStop?.()) {
          return {
            ok: false,
            sessionId,
            error: "run aborted by operator",
            exhaustedTurns: false,
            numTurns: 0,
            costUsd: 0,
            ...(rateLimit ? { rateLimit } : {}),
          };
        }
        continue;
      }

      if (message.type === "result") {
        sessionId ??= message.session_id;
        const usage = { numTurns: message.num_turns, costUsd: message.total_cost_usd };

        if (message.subtype === "success") {
          return { ok: true, sessionId, result: message.result, ...usage };
        }
        // error_during_execution | error_max_turns | error_max_budget_usd |
        // error_max_structured_output_retries
        return {
          ok: false,
          sessionId,
          subtype: message.subtype,
          error: `agent run ended with ${message.subtype}`,
          exhaustedTurns: message.subtype === "error_max_turns",
          ...usage,
          ...(rateLimit ? { rateLimit } : {}),
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      sessionId,
      error: e instanceof Error ? e.message : String(e),
      exhaustedTurns: false,
      // A throw gives us no usage report. Turns were still spent, so callers
      // that bill a budget should treat this as an unknown-but-nonzero charge.
      numTurns: 0,
      costUsd: 0,
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  return {
    ok: false,
    sessionId,
    error: "agent stream ended without a result message",
    exhaustedTurns: false,
    numTurns: 0,
    costUsd: 0,
    ...(rateLimit ? { rateLimit } : {}),
  };
}
