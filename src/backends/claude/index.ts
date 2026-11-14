import { getSessionInfo, renameSession } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackend } from "../../agent/backend.js";
import { CREDENTIAL_VARS, credentialSource } from "./env.js";
import { buildOptions } from "./options.js";
import { runQuery } from "./runner.js";

/**
 * Claude, through the Claude Agent SDK. The default backend.
 *
 * The agent is Claude Code running as a subprocess: its built-in tools are the
 * library's vocabulary already, its transcripts under HOME are what make a
 * thread resumable, and its permission prompt is where approvals wait.
 */
export function claudeAgent(): AgentBackend {
  return {
    name: "claude-agent-sdk",
    secrets: CREDENTIAL_VARS,

    ready(env) {
      const source = credentialSource(env);
      if (source === "none") {
        return {
          ok: false,
          problem:
            "no Anthropic credentials configured — set CLAUDE_CODE_OAUTH_TOKEN (generate with `claude setup-token`) " +
            "or ANTHROPIC_API_KEY, or AGENT_INHERIT_ENV=true for a locally-brokered credential",
        };
      }
      return source === "inherited-env"
        ? { ok: true, source, warning: "AGENT_INHERIT_ENV is on — dev only; the agent can read every env var this process holds" }
        : { ok: true, source };
    },

    /**
     * A deterministic pre-check beats string-matching an error after the fact:
     * it costs no turns, and a lost transcript is a normal consequence of the
     * volume being replaced rather than an exceptional case.
     */
    async canResume(conversationId, workDir) {
      try {
        return (await getSessionInfo(conversationId, { dir: workDir })) !== undefined;
      } catch {
        return false;
      }
    },

    async run(run, sink) {
      let options;
      try {
        options = buildOptions(run);
      } catch (e) {
        return { ok: false, sessionId: undefined, error: e instanceof Error ? e.message : String(e), exhaustedTurns: false, numTurns: 0, costUsd: 0 };
      }
      const outcome = await runQuery(run.prompt, options, sink, run.shouldStop);

      // Give a newly started SDK session a title. `getSessionInfo` — the check
      // that decides whether a thread can be resumed — only reports sessions
      // it can summarise, and a title makes the session findable whatever
      // anyone typed.
      const started = run.resume ? undefined : (outcome.sessionId ?? run.sessionId);
      if (started) {
        await renameSession(started, run.title.trim() || "thread", { dir: run.workDir }).catch(() => undefined);
      }
      return outcome;
    },
  };
}
