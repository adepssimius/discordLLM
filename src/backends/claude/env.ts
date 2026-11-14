/**
 * The Claude backend's own settings, read straight from the environment: the
 * rest of the library has no business knowing which model is behind the bot,
 * or how it is paid for.
 *
 * Credentials — exactly one is needed; the SDK resolves in this order.
 *
 *   CLAUDE_CODE_OAUTH_TOKEN   the subscription path: generate it once with
 *                             `claude setup-token`, then store it as a
 *                             Secret. It draws on subscription rate limits,
 *                             which is why the library's quota guard exists.
 *   ANTHROPIC_API_KEY         API billing.
 *   ANTHROPIC_AUTH_TOKEN
 *
 *   AGENT_INHERIT_ENV=true    DEV ONLY. Forwards the whole parent environment
 *                             to the agent subprocess. Needed when iterating
 *                             inside an environment that brokers credentials
 *                             through env vars (a nested Claude Code session).
 *                             Never set it in the cluster: it would hand the
 *                             agent every token this process holds.
 */

export const CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export type CredentialSource = "oauth-token" | "api-key" | "auth-token" | "inherited-env" | "none";

const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** Which credential the agent subprocess will actually use. Logged at startup. */
export function credentialSource(env: NodeJS.ProcessEnv = process.env): CredentialSource {
  if (set(env.CLAUDE_CODE_OAUTH_TOKEN)) return "oauth-token";
  if (set(env.ANTHROPIC_API_KEY)) return "api-key";
  if (set(env.ANTHROPIC_AUTH_TOKEN)) return "auth-token";
  if (env.AGENT_INHERIT_ENV === "true") return "inherited-env";
  return "none";
}

/**
 * The environment handed to the agent subprocess.
 *
 * Deliberately a short allowlist. The Discord token is never in it, and
 * neither is any MCP server's: the bot process alone talks to Discord, and a
 * server's token goes into that server's own environment. What cannot be
 * withheld is the Anthropic credential, because the subprocess is the thing
 * that uses it.
 */
export function agentEnv(
  o: { readonly timeZone: string; readonly extra?: Readonly<Record<string, string>> },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const extra = o.extra ?? {};
  // Has Claude Code emit a plain-language summary after each group of tool
  // calls, which the live progress message shows instead of the calls
  // themselves. See discord/activity.ts.
  const always = { CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: "1" };

  if (env.AGENT_INHERIT_ENV === "true") {
    const inherited: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) inherited[k] = v;
    return { ...inherited, ...always, ...extra };
  }

  const out: Record<string, string> = {
    ...always,
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TZ: o.timeZone,
  };
  for (const k of CREDENTIAL_VARS) {
    const v = env[k];
    if (set(v)) out[k] = v.trim();
  }
  // HOME is where the SDK writes session transcripts. In-cluster it is on the
  // persistent volume, which is what makes a thread resumable after a restart.
  if (env.HOME) out.HOME = env.HOME;
  return { ...out, ...extra };
}
