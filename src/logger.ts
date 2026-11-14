import { pino, type Logger } from "pino";

/**
 * A backstop, not the primary control: nothing should log a whole config
 * object, and this catches the day something does.
 */
const SECRETS = ["DISCORD_BOT_TOKEN", "DATABASE_URL"];

function redactPaths(extra: readonly string[]): string[] {
  const all = [...new Set([...SECRETS, ...extra])];
  return [...all, ...all.map((s) => `*.${s}`), "headers.authorization", "headers.Authorization"];
}

/** `secrets` are the backend's credentials and a bot's own variable names — an MCP server's token, a GitHub token. */
export function createLogger(opts: { level: string; pretty: boolean; secrets?: readonly string[] }): Logger {
  return pino({
    level: opts.level,
    redact: { paths: redactPaths(opts.secrets ?? []), censor: "[redacted]" },
    ...(opts.pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}

export type { Logger };
