import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The seam, enforced. A model SDK may be imported in exactly one place: that
 * model's own directory under backends/. If this fails, something outside a
 * backend has come to depend on which model is behind the bot.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const MODEL_SDK = /from\s+["'](@anthropic-ai\/[^"']+|openai|@google\/[^"']+|@mistralai\/[^"']+|ollama|@ai-sdk\/[^"']+)["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("the seam to the model", () => {
  it("keeps every model SDK import inside that model's backend", () => {
    const offenders = files(src)
      .map((f) => relative(src, f))
      .filter((f) => !f.startsWith(join("backends", "")))
      .filter((f) => MODEL_SDK.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps each backend to its own SDK", () => {
    for (const f of files(join(src, "backends", "claude"))) {
      const m = MODEL_SDK.exec(readFileSync(f, "utf8"));
      if (m) expect(m[1]).toMatch(/^@anthropic-ai\//);
    }
  });
});
