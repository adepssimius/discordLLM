import { localStamp } from "./agent/prompts.js";
import { NO_APPROVAL } from "./agent/tiers.js";

/**
 * What the agent is told, laid out for a person.
 *
 * When a bot does not behave as wanted, the first question is what it was
 * given. This is the answer, built by the bot process from the same code that
 * builds a real turn (`SessionManager.inspect`) — never by asking the model,
 * which can only paraphrase.
 *
 * It covers what the bot contributes. The backend's own base prompt (for the
 * Claude backend, Claude Code's) sits underneath and is not the library's to
 * show; neither are the tool lists of the MCP servers, which only the running
 * servers know.
 */
export interface PromptReport {
  readonly bot: string;
  readonly profile: string;
  readonly backend: string;
  /** Null when the backend's default model is used. */
  readonly model: string | null;
  /** False describes a scheduled run. */
  readonly interactive: boolean;
  /** Null when describing the first turn of a new conversation. */
  readonly session: { readonly id: string; readonly title: string; readonly turns: number } | null;
  readonly workDir: string;
  readonly tiers: readonly string[];
  readonly approvalLevel: string;
  readonly servers: readonly string[];
  /** The in-process tools, by full name. */
  readonly botTools: readonly string[];
  readonly builtinTools: readonly string[];
  readonly shell: boolean;
  readonly skills: boolean;
  /** What the next turn's system prompt would be. */
  readonly systemPrompt: string;
  readonly systemPromptHash: string;
  /** The lines that open every message to the agent. */
  readonly header: string;
  /** The session's most recent turn, as it was actually sent. */
  readonly last: {
    readonly seq: number;
    readonly status: string;
    readonly trigger: string;
    readonly startedAt: number;
    /** The whole user-side message: header, any recap, what the person wrote. */
    readonly prompt: string;
    /** Null when that turn predates the recording of system prompts. */
    readonly sameSystemPrompt: boolean | null;
    /** That turn's system prompt, only when it differs from the current one. */
    readonly systemPrompt: string | null;
  } | null;
}

/** A fence long enough that nothing inside the text can close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function waits(tiers: readonly string[], level: string): string {
  if (tiers.length < 2) return "no approval ladder";
  if (level === NO_APPROVAL) return "nothing waits";
  const at = tiers.indexOf(level);
  return at === -1 ? `level ${level}` : `${tiers.slice(at).join(", ")} wait`;
}

/** One line, for the message the report file is attached to. */
export function promptSummary(r: PromptReport): string {
  const chars = r.systemPrompt.length.toLocaleString("en-US");
  const changed = r.last?.sameSystemPrompt === false ? " It has changed since this thread's last turn." : "";
  return `System prompt \`${r.systemPromptHash}\`, ${chars} characters, for ${r.session ? "this thread's next turn" : "a new conversation"}.${changed}`;
}

/** The whole report as Markdown. `timeZone` is for the last turn's timestamp. */
export function renderPromptReport(r: PromptReport, timeZone: string): string {
  const out: string[] = [];
  const list = (xs: readonly string[]): string => (xs.length > 0 ? xs.map((x) => `\`${x}\``).join(", ") : "none");

  out.push(
    `# What ${r.bot} is told`,
    "",
    `- Profile: ${r.profile}`,
    `- Describes: ${r.session ? `the next turn of “${r.session.title}” (${r.session.turns} so far)` : "the first turn of a new conversation"}` +
      (r.interactive ? "" : ", as a scheduled run"),
    `- Backend: ${r.backend}, model ${r.model ?? "default"}`,
    `- Working directory: \`${r.workDir}\``,
    `- Approval: ${r.tiers.length > 0 ? `ladder ${r.tiers.join(" < ")}; level \`${r.approvalLevel}\` (${waits(r.tiers, r.approvalLevel)})` : "no ladder"}` +
      (r.interactive ? "" : "; a scheduled run is refused everything above the first tier"),
    `- MCP servers: ${list(r.servers)}`,
    `- The bot's own tools: ${list(r.botTools)}`,
    `- Built-in tools: ${list(r.builtinTools)}${r.shell ? ", plus a shell" : ""}`,
    `- Working directory's skills loaded: ${r.skills ? "yes" : "no"}`,
    "",
    "Not shown: the backend's own base prompt, which the system prompt below is added to, and the",
    "tools each MCP server offers.",
    "",
    `## System prompt (\`${r.systemPromptHash}\`)`,
    "",
    r.systemPrompt.trim().length > 0 ? fenced(r.systemPrompt) : "_Empty: the bot adds nothing to the backend's base prompt._",
    "",
    "## Turn header",
    "",
    "Opens every message to the agent, before what the person wrote.",
    "",
    fenced(r.header),
  );

  if (r.last) {
    out.push(
      "",
      `## Last turn in this thread (#${r.last.seq}, ${r.last.trigger}, ${r.last.status}, ${localStamp(new Date(r.last.startedAt), timeZone)})`,
      "",
      r.last.sameSystemPrompt === null
        ? "Its system prompt was not recorded (the turn predates that)."
        : r.last.sameSystemPrompt
          ? "It ran with the system prompt above."
          : "It ran with a different system prompt, shown after the message.",
      "",
      "The message as sent:",
      "",
      fenced(r.last.prompt),
    );
    if (r.last.systemPrompt !== null) out.push("", "Its system prompt:", "", fenced(r.last.systemPrompt));
  }

  return `${out.join("\n")}\n`;
}
