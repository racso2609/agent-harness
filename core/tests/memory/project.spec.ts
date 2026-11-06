import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeGitRemote, readGitRemote, resolveProjectIdentity } from "../../src/memory";

// Stands in for a real git repo: the test controls the remote, or its absence.
const remoteOf = (remote: string | undefined) => (): string | undefined => remote;

describe("resolveProjectIdentity", () => {
  it("prefers the configured project over everything else", () => {
    const identity = resolveProjectIdentity({
      configured: "explicit",
      cwd: "/work/api",
      readGitRemote: remoteOf("git@github.com:owner/api.git"),
    });

    expect(identity).toEqual({ key: "explicit", source: "config" });
  });

  it("trims the configured project", () => {
    const identity = resolveProjectIdentity({
      configured: "  explicit  ",
      cwd: "/work/api",
      readGitRemote: remoteOf(undefined),
    });

    expect(identity).toEqual({ key: "explicit", source: "config" });
  });

  it("ignores a blank configured project and falls through to git", () => {
    const identity = resolveProjectIdentity({
      configured: "   ",
      cwd: "/work/api",
      readGitRemote: remoteOf("https://github.com/owner/api.git"),
    });

    expect(identity).toEqual({ key: "owner/api", source: "git" });
  });

  it.each([
    ["git@github.com:racso2609/agent-harness.git", "racso2609/agent-harness"],
    ["https://github.com/racso2609/agent-harness.git", "racso2609/agent-harness"],
    ["https://gitlab.com/grupo/sub/proyecto", "grupo/sub/proyecto"],
    ["ssh://git@host:22/owner/repo.git", "owner/repo"],
    ["git@github.com:owner/repo", "owner/repo"],
    ["https://user:token@github.com/owner/repo.git", "owner/repo"],
    ["git://github.com/owner/repo.git", "owner/repo"],
  ])("normalizes the remote %s to %s", (remote, expected) => {
    expect(normalizeGitRemote(remote)).toBe(expected);
  });

  it.each(["no-es-una-url", "", "   ", "https://github.com/", "/"])(
    "falls back to the path when the remote %p is unusable",
    (remote) => {
      const identity = resolveProjectIdentity({
        cwd: "/work/cliente-a/api",
        readGitRemote: remoteOf(remote),
      });

      expect(identity.source).toBe("path");
      expect(identity.key).not.toBe("api");
    },
  );

  it("gives two directories with the same basename different keys", () => {
    const a = resolveProjectIdentity({
      cwd: "/work/cliente-a/api",
      readGitRemote: remoteOf(undefined),
    });
    const b = resolveProjectIdentity({
      cwd: "/work/cliente-b/api",
      readGitRemote: remoteOf(undefined),
    });

    expect(a.source).toBe("path");
    expect(b.source).toBe("path");
    expect(a.key).not.toBe(b.key);
    expect(a.key).toMatch(/^api-[0-9a-f]{6}$/);
    expect(b.key).toMatch(/^api-[0-9a-f]{6}$/);
  });

  it("is deterministic for the same directory", () => {
    const first = resolveProjectIdentity({
      cwd: "/work/cliente-a/api",
      readGitRemote: remoteOf(undefined),
    });
    const second = resolveProjectIdentity({
      cwd: "/work/cliente-a/api",
      readGitRemote: remoteOf(undefined),
    });

    expect(first).toEqual(second);
  });

  it("normalizes the path before hashing it", () => {
    const plain = resolveProjectIdentity({
      cwd: "/work/cliente-a/api",
      readGitRemote: remoteOf(undefined),
    });
    const messy = resolveProjectIdentity({
      cwd: "/work/cliente-a/other/../api/",
      readGitRemote: remoteOf(undefined),
    });

    expect(messy).toEqual(plain);
  });

  it.each(["", "   ", "/"])("does not throw and returns a non-empty key for cwd %p", (cwd) => {
    const identity = resolveProjectIdentity({ cwd, readGitRemote: remoteOf(undefined) });

    expect(identity.source).toBe("path");
    expect(identity.key.length).toBeGreaterThan(0);
    expect(identity.key).toBe("default");
  });

  it("falls back to the path when the remote reader throws", () => {
    const identity = resolveProjectIdentity({
      cwd: "/work/api",
      readGitRemote: () => {
        throw new Error("boom");
      },
    });

    expect(identity.source).toBe("path");
    expect(identity.key).toMatch(/^api-[0-9a-f]{6}$/);
  });
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });

    return true;
  } catch {
    return false;
  }
})();

describe("readGitRemote", () => {
  const dirs: string[] = [];

  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-identity-"));
    dirs.push(dir);

    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a directory that is not a git repo", () => {
    expect(readGitRemote(tempDir())).toBeUndefined();
  });

  it.skipIf(!hasGit)("reads the origin remote of a real repo", () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:owner/repo.git"], {
      cwd: dir,
      stdio: "pipe",
    });

    expect(readGitRemote(dir)).toBe("git@github.com:owner/repo.git");
    expect(resolveProjectIdentity({ cwd: dir })).toEqual({ key: "owner/repo", source: "git" });
  });
});
