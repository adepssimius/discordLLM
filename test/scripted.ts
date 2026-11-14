import type { AgentBackend, AgentOutcome, AgentRun, AgentSink } from "../src/agent/backend.js";

/**
 * A stand-in model: it does exactly what a test tells it to. It is also the
 * smallest complete example of the backend contract — it never imports a
 * model SDK, puts every tool call through the guard before "running" it, and
 * keeps its own record of which conversations exist.
 */
export type Step =
  | { readonly say: string }
  /** Ask the guard, then — if allowed — run the in-process tool of that name, if there is one. */
  | { readonly call: string; readonly input?: unknown };

export interface Scripted extends AgentBackend {
  /** What the next run does. */
  script: Step[];
  /** Every run it was handed, in order. */
  readonly runs: AgentRun[];
  /** What each tool call came to: `allowed`, or the refusal's message. */
  readonly calls: { tool: string; result: string }[];
  /** Forget a conversation, as a replaced volume would. */
  forget(conversationId: string): void;
  fail?: string | undefined;
}

export function scriptedBackend(): Scripted {
  const known = new Set<string>();
  const backend: Scripted = {
    name: "scripted",
    secrets: ["SCRIPTED_KEY"],
    script: [],
    runs: [],
    calls: [],
    forget: (id) => void known.delete(id),
    ready: () => ({ ok: true, source: "test" }),
    canResume: async (id) => known.has(id),

    async run(run: AgentRun, sink: AgentSink): Promise<AgentOutcome> {
      backend.runs.push(run);
      const id = run.resume ?? run.sessionId;
      if (id) known.add(id);
      if (id) sink.onSession?.(id);
      if (backend.fail) return { ok: false, sessionId: id, error: backend.fail, exhaustedTurns: false, numTurns: 1, costUsd: 0 };

      let last = "";
      let n = 0;
      for (const step of backend.script) {
        if (run.shouldStop()) return { ok: false, sessionId: id, error: "run aborted by operator", exhaustedTurns: false, numTurns: n, costUsd: 0 };
        n += 1;
        if ("say" in step) {
          last = step.say;
          sink.onText?.(step.say);
          continue;
        }
        const input = step.input ?? {};
        const useId = `use-${n}`;
        sink.onToolUse?.(step.call, input, useId);
        const a = await run.guard.authorize(step.call, input, { signal: new AbortController().signal, toolUseId: useId });
        if (!a.allow) {
          backend.calls.push({ tool: step.call, result: a.message ?? "refused" });
          continue;
        }
        const prefix = `mcp__${run.toolServer}__`;
        const own = step.call.startsWith(prefix) ? run.tools.find((t) => t.name === step.call.slice(prefix.length)) : undefined;
        if (step.call.startsWith(prefix) && !own) {
          backend.calls.push({ tool: step.call, result: "no such tool" });
          continue;
        }
        const out = own ? await own.handler(input as never) : undefined;
        backend.calls.push({ tool: step.call, result: out ? (out.isError ? `error: ${out.content[0]?.text}` : "allowed") : "allowed" });
      }
      return { ok: true, sessionId: id, result: last, numTurns: n, costUsd: 0.01 * n };
    },
  };
  return backend;
}
