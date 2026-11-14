import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { box, rules } from "../../test/kit.js";
import { ALLOW, deny } from "../definition.js";
import { evaluate, type PolicyRules } from "./policy.js";

const ws = "/data/workspace";
const call = (
  toolName: string,
  toolInput: unknown,
  opts: { interactive?: boolean; aborted?: boolean; rules?: PolicyRules } = {},
) =>
  evaluate(opts.rules ?? rules, {
    toolName,
    toolInput,
    workDir: ws,
    interactive: opts.interactive ?? true,
    aborted: opts.aborted ?? false,
  });

describe("files stay inside the workspace", () => {
  it("allows editing the notes, relative or absolute", () => {
    expect(call("Edit", { file_path: "CLAUDE.md" }).allow).toBe(true);
    expect(call("Write", { file_path: `${ws}/drafts/import.csv` }).allow).toBe(true);
  });

  it("allows reading a posted photo", () => {
    expect(call("Read", { file_path: "inbox/abc/123-1-IMG_0001.HEIC" }).allow).toBe(true);
  });

  it("allows scratch files under the temp directory", () => {
    expect(call("Write", { file_path: join(tmpdir(), "x.json") }).allow).toBe(true);
  });

  it("refuses the database and anything else on the volume", () => {
    expect(call("Write", { file_path: "/data/bot.db" }).allow).toBe(false);
    expect(call("Edit", { file_path: "../bot.db" }).allow).toBe(false);
    // Shares a prefix with the workspace; a startsWith check would pass it.
    expect(call("Write", { file_path: "/data/workspace-other/x" }).allow).toBe(false);
  });

  it("refuses reading outside it — another process's environment included", () => {
    expect(call("Read", { file_path: "/proc/1/environ" }).allow).toBe(false);
    expect(call("Grep", { pattern: "TOKEN", path: "/proc" }).allow).toBe(false);
    expect(call("Glob", { pattern: "**/*", path: "/data" }).allow).toBe(false);
  });

  it("refuses a write with no path", () => {
    expect(call("Write", { content: "x" }).allow).toBe(false);
  });
});

describe("a bot with a shell", () => {
  const shell: PolicyRules = { ...rules, shell: true, confineReads: false };

  it("may run Bash and read anywhere, since Bash could anyway", () => {
    expect(call("Bash", { command: "ls" }, { rules: shell }).allow).toBe(true);
    expect(call("Read", { file_path: "/etc/hosts" }, { rules: shell }).allow).toBe(true);
  });

  it("still cannot write outside its directory with the file tools", () => {
    expect(call("Write", { file_path: "/data/bot.db" }, { rules: shell }).allow).toBe(false);
  });
});

describe("there is no shell by default", () => {
  it("refuses Bash even if it were registered", () => {
    expect(call("Bash", { command: "env" }).allow).toBe(false);
  });
});

describe("the bot's own rules", () => {
  it("run after the library's and can refuse", () => {
    expect(call(box("attach_document"), { source: "inbox/s/1-1-drill.jpg" }).allow).toBe(true);
    expect(call(box("attach_document"), { source: "https://example.com/manual.pdf" }).allow).toBe(true);
    for (const source of ["/proc/self/environ", "../bot.db", "~/.ssh/id_rsa", "/etc/passwd"]) {
      expect(call(box("attach_document"), { source }).allow).toBe(false);
    }
  });

  it("confine a path-like argument nobody listed", () => {
    expect(call(box("import_photos"), { folder_path: "/etc" }).allow).toBe(false);
    expect(call(box("import_photos"), { folder_path: "inbox/s" }).allow).toBe(true);
    expect(call(box("export_csv"), { save_to: "/data/x.csv" }).allow).toBe(false);
    expect(call(box("make_label"), { out_dir: "/tmp/../data" }).allow).toBe(false);
  });

  it("cannot allow what the library refused", () => {
    const lax: PolicyRules = { ...rules, policy: () => ALLOW };
    expect(call("Write", { file_path: "/etc/passwd" }, { rules: lax }).allow).toBe(false);
    expect(call("Bash", { command: "env" }, { rules: lax }).allow).toBe(false);
  });

  it("see the call split into server and tool", () => {
    const seen: string[] = [];
    const spy: PolicyRules = {
      ...rules,
      policy: (c) => {
        seen.push(`${c.server}/${c.tool}/${c.workDir}/${c.interactive}`);
        return deny("no");
      },
    };
    expect(call(box("get_item"), {}, { rules: spy }).allow).toBe(false);
    expect(seen).toEqual([`box/get_item/${ws}/true`]);
  });
});

describe("scheduled runs only look", () => {
  it("allows reads", () => {
    expect(call(box("list_warranties"), {}, { interactive: false }).allow).toBe(true);
  });

  it("refuses any change", () => {
    const d = call(box("set_item"), { identifier: "Drill" }, { interactive: false });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/scheduled run only looks/);
  });

  it("leaves interactive calls to the approval step", () => {
    expect(call(box("set_item"), {}).allow).toBe(true);
    expect(call(box("delete_item"), {}).allow).toBe(true);
  });

  it("leaves unclassified tools alone", () => {
    expect(call("mcp__bot__poll", {}, { interactive: false }).allow).toBe(true);
  });
});

describe("stop", () => {
  it("refuses everything once the run is stopped", () => {
    expect(call(box("get_item"), {}, { aborted: true }).allow).toBe(false);
  });
});
