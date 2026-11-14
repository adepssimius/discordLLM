#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds a bot's container image, from the bot's own repository:
 *
 *   pnpm exec discordllm-build            build and load it locally
 *   pnpm exec discordllm-build --push     build and push (CI)
 *   pnpm exec discordllm-build --print    show the docker command, run nothing
 *
 * The Dockerfile is this library's (docker/Dockerfile): every bot is the same
 * Node process plus whichever MCP servers it bakes in, so there is one recipe
 * and a bot only says what differs, in its package.json:
 *
 *   "discordllm": {
 *     "uvTools": ["homebox-mcp==1.5.1"],          MCP servers installed with uv, pinned
 *     "uvPython": "3.13",
 *     "aptPackages": ["git"],                      extra Debian packages at runtime
 *     "smoke": "python -c 'import homebox_mcp'"    run in the tools stage; a failure fails the build
 *   }
 *
 * The image is named after the repository the bot lives in —
 * `ghcr.io/<owner>/<repo>` — from GITHUB_REPOSITORY in CI, or the `origin`
 * remote locally. `--image` or `"discordllm": { "image": … }` overrides it.
 *
 * Tags: a git tag is used verbatim; a CI build of a branch is
 * `<branch>-<run number>-<short sha>`, which sorts numerically on the run
 * number; a local build is `dev-<short sha>`.
 */

export interface BuildSettings {
  readonly uvTools?: readonly string[];
  readonly uvPython?: string;
  readonly aptPackages?: readonly string[];
  readonly smoke?: string;
  readonly image?: string;
  readonly platforms?: string;
}

export interface BuildPlan {
  readonly image: string;
  readonly tag: string;
  readonly args: string[];
}

/** `git@github.com:Owner/Repo.git` or `https://github.com/Owner/Repo` → `owner/repo`. */
export function repoFromRemote(url: string): string | undefined {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

export function imageName(o: {
  flag?: string | undefined;
  settings: BuildSettings;
  env: NodeJS.ProcessEnv;
  remote?: string | undefined;
  packageName: string;
}): string {
  if (o.flag) return o.flag;
  if (o.settings.image) return o.settings.image;
  const registry = o.env.DISCORDLLM_REGISTRY ?? "ghcr.io";
  const repo = o.env.GITHUB_REPOSITORY?.toLowerCase() ?? (o.remote ? repoFromRemote(o.remote) : undefined);
  // No repository to name it after: a local-only name, which cannot be pushed by accident.
  return repo ? `${registry}/${repo}` : o.packageName.replace(/^@[^/]+\//, "").toLowerCase();
}

export function imageTag(o: { flag?: string | undefined; env: NodeJS.ProcessEnv; sha?: string | undefined }): string {
  if (o.flag) return o.flag;
  const short = (o.env.GITHUB_SHA ?? o.sha ?? "").slice(0, 7);
  const ref = o.env.GITHUB_REF ?? "";
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  if (o.env.GITHUB_RUN_NUMBER && short) {
    const branch = (o.env.GITHUB_REF_NAME ?? "main").replace(/[^A-Za-z0-9_.-]+/g, "-");
    return `${branch}-${o.env.GITHUB_RUN_NUMBER}-${short}`;
  }
  return short ? `dev-${short}` : "dev";
}

const SAFE = /^[A-Za-z0-9@._+=:/~<>!,\[\]-]+$/;

export function plan(o: {
  botDir: string;
  dockerfile: string;
  image: string;
  tag: string;
  settings: BuildSettings;
  push: boolean;
  env: NodeJS.ProcessEnv;
}): BuildPlan {
  const { settings } = o;
  for (const spec of [...(settings.uvTools ?? []), ...(settings.aptPackages ?? [])]) {
    // These are interpolated into a RUN line. Package specs never need a space or a quote.
    if (!SAFE.test(spec)) throw new Error(`'${spec}' is not a plain package spec`);
  }
  const args = ["buildx", "build", "--file", o.dockerfile, "--target", "runtime", "--tag", `${o.image}:${o.tag}`];
  const arg = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== "") args.push("--build-arg", `${k}=${v}`);
  };
  arg("UV_TOOLS", (settings.uvTools ?? []).join(" "));
  arg("UV_PYTHON", settings.uvPython);
  arg("APT_PACKAGES", (settings.aptPackages ?? []).join(" "));
  arg("TOOLS_SMOKE", settings.smoke);
  args.push("--platform", settings.platforms ?? o.env.DISCORDLLM_PLATFORMS ?? "linux/amd64");
  // In Actions, with the runtime token exposed, layers are cached between runs.
  if (o.env.ACTIONS_RUNTIME_TOKEN) args.push("--cache-from", "type=gha", "--cache-to", "type=gha,mode=max");
  args.push(o.push ? "--push" : "--load", o.botDir);
  return { image: o.image, tag: o.tag, args };
}

function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  if (has("help")) {
    console.log("discordllm-build [--push] [--print] [--image name] [--tag tag] [--dir path]");
    return;
  }

  const botDir = resolve(flag("dir") ?? process.cwd());
  const pkgPath = join(botDir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json in ${botDir} — run this from the bot's repository`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; discordllm?: BuildSettings };
  const settings = pkg.discordllm ?? {};

  const dockerfile = join(dirname(fileURLToPath(import.meta.url)), "..", "docker", "Dockerfile");
  const built = plan({
    botDir,
    dockerfile,
    image: imageName({
      flag: flag("image"),
      settings,
      env: process.env,
      remote: git(botDir, "remote", "get-url", "origin"),
      packageName: pkg.name ?? "bot",
    }),
    tag: imageTag({ flag: flag("tag"), env: process.env, sha: git(botDir, "rev-parse", "HEAD") }),
    settings,
    push: has("push"),
    env: process.env,
  });

  console.log(`docker ${built.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  if (has("print")) return;

  const r = spawnSync("docker", built.args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);

  const ref = `${built.image}:${built.tag}`;
  console.log(has("push") ? `Published ${ref}` : `Built ${ref}`);
  if (process.env.GITHUB_OUTPUT) {
    execFileSync("sh", ["-c", 'printf "image=%s\\ntag=%s\\n" "$0" "$1" >> "$GITHUB_OUTPUT"', built.image, built.tag]);
  }
}

/** True when this file is the command being run — through a package manager's symlink or not. */
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

// Only when run as the command, not when imported by a test.
if (invokedDirectly()) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
