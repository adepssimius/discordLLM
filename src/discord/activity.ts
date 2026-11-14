import { isAbsolute, relative } from "node:path";

/**
 * What the agent is doing, in words, for the live progress message.
 *
 * The first version printed the tool call itself — `Bash command=cd /data/
 * threads/3134e30a-… && python3 scripts/verify_plan.py | tail -3` — which is
 * accurate and tells the person reading it on a phone nothing. What they want
 * is why: "Checking the plan still passes its checks".
 *
 * Two sources, used in turn:
 *
 *  - **The moment a call starts**, `describeToolCall` phrases it from its own
 *    input. Claude Code's Bash tool carries a `description` the model writes
 *    for exactly this purpose, TodoWrite carries the step in progress, and the
 *    file tools are phrased around the file.
 *  - **A few seconds later**, Claude Code emits its own summary of a group of
 *    calls ("Read AGENTS.md & verify_plan.py"). `Activity.summarise` folds the
 *    lines it covers into that one.
 *
 * Pure, so the phrasing is unit tested.
 */

export interface ActivityLine {
  /** The tool calls this line stands for. Empty once nothing can replace it. */
  readonly ids: readonly string[];
  readonly text: string;
}

const MAX_LINE = 90;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
};

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function str(input: unknown, key: string): string | undefined {
  const v = field(input, key);
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * A bot's wording for the live progress message.
 *
 * Without one, an MCP tool is described by its own name with the underscores
 * taken out — readable, but jargon. A phrasebook says it the way the person
 * would: `search_items` becomes "Searching the inventory".
 */
export interface Phrasebook {
  /** What the working directory is called: "the inventory notes", "the repository". */
  readonly rootLabel?: string;
  /** server → tool → phrase. */
  readonly phrases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** server → what the service is called, used when a tool has no phrase: "Homebox: finalize photos". */
  readonly services?: Readonly<Record<string, string>>;
  /** Argument names, in order, that name what a call is about; appended after the phrase. */
  readonly subjectKeys?: readonly string[];
  /** Phrases for Claude Code's own tools, by name, where the bot knows what one is being used for. */
  readonly builtins?: Readonly<Record<string, string>>;
  /**
   * The bot's own line for a call, tried before everything above — for a tool
   * whose arguments say more than its name does. Return undefined to fall
   * through.
   */
  describe?(call: { readonly server: string; readonly tool: string; readonly input: unknown }): string | undefined;
}

/** A path as the person thinks of it: relative to the working directory, not the pod. */
export function displayPath(path: string, root?: string, rootLabel = "the working directory"): string {
  if (root) {
    const rel = relative(root, path);
    if (rel === "") return rootLabel;
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  // Outside the workspace (a scratch file in /tmp): the file name is what matters.
  return isAbsolute(path) ? (path.split("/").filter(Boolean).pop() ?? path) : path;
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

/** `list_custom_fields` → "list custom fields". */
const words = (name: string): string => name.replace(/[_-]+/g, " ").trim();

/** The library's own tools, whatever the in-process server is called. */
const BOT_PHRASES: Readonly<Record<string, string>> = {
  poll: "Preparing a poll",
  schedule_list: "Looking at the schedules",
  schedule_set: "Saving a schedule",
  schedule_delete: "Removing a schedule",
  schedule_run_now: "Starting a scheduled brief",
};

/** One line saying what a tool call is for. */
export function describeToolCall(name: string, input: unknown, root?: string, book: Phrasebook = {}): string {
  const path = (key = "file_path"): string => {
    const p = str(input, key);
    return p ? code(displayPath(p, root, book.rootLabel)) : "a file";
  };

  const builtin = book.builtins?.[name];
  if (builtin) return clip(builtin);

  switch (name) {
    case "Bash": {
      // Claude Code asks the model for this description on every Bash call,
      // precisely so a person can see what a command is for.
      const d = str(input, "description");
      return clip(d ?? "Running a command");
    }
    case "Read":
      return clip(`Reading ${path()}`);
    case "Edit":
    case "MultiEdit":
      return clip(`Editing ${path()}`);
    case "Write":
      return clip(`Writing ${path()}`);
    case "NotebookEdit":
      return clip(`Editing ${path("notebook_path")}`);
    case "Glob":
      return clip(`Looking for files matching ${code(str(input, "pattern") ?? "*")}`);
    case "Grep": {
      const where = str(input, "path");
      return clip(
        `Searching for ${code(str(input, "pattern") ?? "")}${where ? ` in ${code(displayPath(where, root, book.rootLabel))}` : ""}`,
      );
    }
    case "WebSearch":
      return clip(`Searching the web for “${str(input, "query") ?? ""}”`);
    case "Skill":
      return clip(`Using the ${str(input, "skill") ?? str(input, "command") ?? ""} skill`);
    case "TodoWrite": {
      // The step being worked on, in the model's own words.
      const todos = field(input, "todos");
      if (Array.isArray(todos)) {
        const active = todos.find((t) => field(t, "status") === "in_progress");
        const phrase = str(active, "activeForm") ?? str(active, "content");
        if (phrase) return clip(phrase);
      }
      return "Planning the next steps";
    }
  }

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", tool = ""] = mcp;
    const custom = book.describe?.({ server, tool, input });
    if (custom) return clip(custom);
    const known = book.phrases?.[server]?.[tool];
    if (known) {
      // Said from its input: which item is the whole point.
      const subject = (book.subjectKeys ?? []).map((k) => str(input, k)).find((v) => v !== undefined);
      return clip(subject ? `${known}: ${subject}` : known);
    }
    const own = BOT_PHRASES[tool];
    if (own && !book.services?.[server]) return own;
    const service = book.services?.[server];
    return clip(service ? `${service}: ${words(tool)}` : words(tool));
  }

  return clip(words(name));
}

/**
 * The running list of activity lines for one turn.
 *
 * A line is added when a call starts and replaced when Claude Code summarises
 * the calls it covers. Repeats collapse — reading three files in a row is
 * three lines, but the same Bash description five times is one.
 */
export class Activity {
  private lines: ActivityLine[] = [];

  add(id: string, text: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.text === text) {
      this.lines[this.lines.length - 1] = { ids: [...last.ids, id], text };
      return;
    }
    this.lines.push({ ids: [id], text });
  }

  /** Replaces the lines covering `ids` with one line, where the first of them stood. */
  summarise(summary: string, ids: readonly string[]): void {
    const covered = new Set(ids);
    const first = this.lines.findIndex((l) => l.ids.some((id) => covered.has(id)));
    if (first === -1) return;
    const kept = this.lines.filter((l, i) => i < first || !l.ids.some((id) => covered.has(id)));
    kept.splice(first, 0, { ids: [], text: clip(summary) });
    this.lines = kept;
  }

  /** The most recent lines, oldest first. */
  recent(n: number): string[] {
    return this.lines.slice(-n).map((l) => l.text);
  }
}
