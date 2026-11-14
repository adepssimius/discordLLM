import type { PostedFile } from "../session/types.js";
import { NO_APPROVAL } from "./tiers.js";

/**
 * What the agent is told.
 *
 * Two halves. The per-turn half — the header with the date, the person's
 * message, a brief's framing, a poll answer — is the library's, because the
 * session manager and the transcript depend on its exact shape.
 *
 * The system prompt is the bot's (`Domain.turn`). What it says about the
 * place the agent is working in cannot be written here. The parts that are
 * about this library's own features can, and `sections` below has them, so a
 * bot describes schedules, polls and Discord formatting in the same words as
 * every other bot unless it has a reason not to.
 */

/** The in-process server's default name. */
export const BOT_SERVER = "bot";

export interface SectionContext {
  /** The full name of one of the bot server's tools: `mcp__bot__poll`. */
  readonly botTool: (name: string) => string;
  readonly timeZone: string;
}

const tick = (s: string): string => `\`${s}\``;

export const sections = {
  /** How approval works, for a bot with a ladder. `summary` says what waits at this level. */
  approval(summary: string): string {
    return `### Approval

${summary}

When a call needs approval, the person sees what you are about to do with Approve and Deny buttons,
and your call simply waits for the answer. So:

- Do not ask in prose first and then make the call — the button is the question. Say in a sentence
  what you are about to change, then make the call.
- If a call comes back refused or timed out, nothing happened. Do not retry it, and do not reach the
  same result another way. Say what you were going to do and stop.
- Only change what the person asked for, or what they agreed to when you proposed it. Looking is
  free; changing is on request.`;
  },

  /** A generic one-liner for `approval()` when the bot has nothing more exact to say. */
  approvalSummary(tiers: readonly string[], level: string): string {
    if (level === NO_APPROVAL) return "Nothing waits for approval: every change goes straight through. Be correspondingly careful.";
    const waits = tiers.slice(tiers.indexOf(level));
    return `Calls classed as ${waits.join(" or ")} wait for approval. Everything below that goes straight through.`;
  },

  /** The notes file in a shared working directory. `subject` is what the notes are about: "inventory", "house". */
  notes(c: { readonly file: string; readonly subject: string; readonly examples?: string; readonly record?: string }): string {
    return `## ${c.subject.charAt(0).toUpperCase()}${c.subject.slice(1)} notes

Your working directory holds the ${c.subject} notes, ${tick(c.file)}. Claude Code loads it into every
conversation, in every thread. Keep it useful:

- Add what you learn that a later conversation would otherwise have to rediscover${c.examples ? `: ${c.examples}` : "."}
${c.record ? `- ${c.record}\n` : ""}- Keep it short and current. Edit or delete what is wrong rather than appending corrections.
- Never write a token, password or other secret into it.

Other files you write there are scratch. Nothing outside the working directory is readable or
writable.`;
  },

  attachments(c: { readonly inboxDir: string }): string {
    return `## Photos and files from Discord

People post photos and sometimes PDFs. The bot saves each one under ${tick(`${c.inboxDir}/`)} in your
working directory and tells you its path in the message. JPEG, PNG, GIF and WebP photos are also shown
to you directly in that message; for anything else (HEIC, PDF), use Read on the path to look at it.

Look at what was sent and use it: read what is written on it rather than asking the person to type it,
and say what you read, so a misread is caught.`;
  },

  schedules(c: SectionContext & { readonly examples?: string; readonly scheduledRun?: string }): string {
    const t = (n: string): string => tick(c.botTool(n));
    return `## Scheduled briefs

The person can ask for a recurring message${c.examples ? ` — ${c.examples}` : ""}. Those are schedules:

- ${t("schedule_set")} creates or replaces one. Times are in ${c.timeZone}.
- ${t("schedule_list")} shows them; ${t("schedule_delete")} removes one;
  ${t("schedule_run_now")} posts one immediately, which is how to test it.

${c.scheduledRun ? `${c.scheduledRun} ` : ""}The prompt you store runs later in a fresh conversation that remembers nothing of
this one, so write it to stand alone. Its answer is posted to the channel, and the person may
continue it as a thread.`;
  },

  polls(c: SectionContext & { readonly examples?: string }): string {
    return `## Polls

${tick(c.botTool("poll"))} asks a multiple-choice question as a native Discord poll: the person answers with one
tap instead of typing. The poll is posted directly under your reply, and their answer arrives as
their next message, marked as a poll answer, with the ${tick("key")} you gave it.

Use one when the answer is one of a few known things${c.examples ? ` — ${c.examples}` : ""}. Not for an open question, for
something you can look up, or to ask permission for a change. At most three per reply; one is
usually right.`;
  },

  formatting(c: { readonly extra?: readonly string[] } = {}): string {
    return `## Formatting for Discord

- The person sees everything you write in a turn, in order, as one reply. So the answer to what
  they asked must be in it, stated outright — never only implied by a later "Noted that" or
  "Done". Do housekeeping after the answer, and mention it in at most one short line, or not at all.
- A message is capped at 2000 characters and long answers are split. Lead with the answer.
- **For tabular data, write an ordinary markdown table.** Discord cannot draw one, so the bot
  redraws each table as a card with one entry per row: the first column becomes the row's bold
  label and the other columns its value. Keep cells short, and keep a table to about 20 rows.
- A column of ratings written as GREEN, AMBER or RED is drawn as a coloured dot on each row, and the
  worst one colours the card.${(c.extra ?? []).map((l) => `\n- ${l}`).join("")}`;
  },
};

export interface TurnContext {
  /** Extra lines from the bot, already phrased as `- key: value`. */
  readonly extraLines?: readonly string[] | undefined;
  readonly now: Date;
  readonly timeZone: string;
}

/** `Friday 2026-10-02 06:31` in the configured zone. */
export function localStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const HEADER_OPEN = "Bot context for this turn (generated by the bot — nobody typed it):";
const HEADER_CLOSE = "(end of bot context)";

/**
 * The facts that change between turns and that the agent would otherwise
 * have to spend a tool call on, or guess: what time it is, and whatever the
 * bot adds (how a thread's branch stands, say).
 *
 * Plain lines, deliberately not an XML-style block. The SDK decides whether a
 * stored session "exists" by finding a human-looking prompt in its transcript,
 * and it skips any prompt that opens with a tag — which would make a thread
 * impossible to resume after a restart. prompts.test.ts pins the first
 * character.
 */
export function turnHeader(c: TurnContext): string {
  return [
    HEADER_OPEN,
    `- Now: ${localStamp(c.now, c.timeZone)} (${c.timeZone})`,
    ...(c.extraLines ?? []),
    HEADER_CLOSE,
  ].join("\n");
}

/** Removes the header from a stored prompt, leaving what the person wrote. */
export function stripTurnHeader(prompt: string): string {
  const start = prompt.indexOf(HEADER_OPEN);
  const end = prompt.indexOf(HEADER_CLOSE);
  if (start === -1 || end === -1 || end < start) return prompt;
  return (prompt.slice(0, start) + prompt.slice(end + HEADER_CLOSE.length)).trim();
}

export interface ChatMessageContext {
  readonly authorDisplayName: string;
  readonly content: string;
  /** Messages that arrived while a previous run was still in flight. */
  readonly coalescedWith?: readonly string[];
  /**
   * The thread's existing conversation, when joining one the bot did not open.
   * First turn only — afterwards the SDK session carries it.
   */
  readonly threadContext?: string | undefined;
  /** Files posted with this message (and any coalesced with it), already saved in the workspace. */
  readonly files?: readonly PostedFile[];
  /** Paths of the files shown inline as images. */
  readonly shown?: ReadonlySet<string>;
  /** Files that were posted but not saved, one line each. */
  readonly skippedFiles?: readonly string[];
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The lines telling the agent what was posted, where it is, and whether it can already see it. */
export function filesBlock(
  files: readonly PostedFile[],
  shown: ReadonlySet<string>,
  skipped: readonly string[] = [],
): string {
  if (files.length === 0 && skipped.length === 0) return "";
  const lines: string[] = [];
  if (files.length > 0) {
    lines.push("Files they posted, saved in your working directory (a tool that takes a local file takes this path):");
    let n = 0;
    for (const f of files) {
      const kind = f.contentType ?? "unknown type";
      let note: string;
      if (shown.has(f.path)) {
        n += 1;
        note = `shown below as image ${n}`;
      } else if (f.image) {
        note = "not shown — Read it to look at it";
      } else {
        note = "Read it if you need its contents";
      }
      lines.push(`- \`${f.path}\` — “${f.name}”, ${kind}, ${size(f.bytes)}; ${note}`);
    }
  }
  if (skipped.length > 0) {
    lines.push("Not saved:");
    for (const s of skipped) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}

export function chatUserPrompt(m: ChatMessageContext, turn: TurnContext): string {
  const lines: string[] = [turnHeader(turn), ""];

  if (m.threadContext) lines.push(m.threadContext, "");

  const text = m.content.trim().length > 0 ? m.content : "(no text — just the files below)";
  lines.push(`${m.authorDisplayName} says:`, "", text);

  if (m.coalescedWith && m.coalescedWith.length > 0) {
    lines.push("", "They then added, before you replied:");
    for (const extra of m.coalescedWith) lines.push("", extra);
  }

  const files = filesBlock(m.files ?? [], m.shown ?? new Set(), m.skippedFiles ?? []);
  if (files) lines.push("", files);
  return lines.join("\n");
}

/** What a scheduled run is told when the bot has an approval ladder and says nothing else. */
export const BRIEF_ONLY_LOOKS =
  "This run only looks. Every change is refused during it, so do not try; if something should be\n" +
  "changed, say what and why, and the person can ask for it from the thread.";

export function briefUserPrompt(
  schedule: { readonly name: string; readonly prompt: string },
  turn: TurnContext,
  /** The bot's own sentences about what a scheduled run may and may not do. */
  note?: string,
): string {
  return [
    turnHeader(turn),
    "",
    `This is the scheduled brief "${schedule.name}". Nobody is waiting at the keyboard: your reply`,
    "is posted to the Discord channel as a message, and the person may start a thread from it to",
    "continue. Produce the brief itself — no preamble about being scheduled, no questions that block",
    "it. If something it needs is unavailable, say which thing, and give the rest.",
    ...(note ? ["", note] : []),
    "",
    "The brief to produce:",
    "",
    schedule.prompt,
  ].join("\n");
}

/**
 * A settled poll vote, phrased as the message it stands in for.
 *
 * Says outright that it is a poll answer and which poll: the agent may have
 * asked two at once.
 */
export function pollAnswerContent(poll: { key: string; question: string }, chosen: readonly string[]): string {
  const answer = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
  return [
    `Poll answer (${poll.key}) — tapped, not typed.`,
    `Question: ${poll.question}`,
    chosen.length === 1 ? `Answer: ${answer}` : `Answers:\n${answer}`,
    "",
    "Do with it what you asked for it for.",
  ].join("\n");
}
