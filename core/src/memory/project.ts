import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

// How a project key was derived. Kept next to the key so logs and /memory can
// explain where the memories are coming from.
export type ProjectIdentitySource = "config" | "git" | "path";

export interface ProjectIdentity {
  // Stable key used as `observations.project`. Never empty.
  key: string;
  // How the key was derived, for logs and for `/memory` to explain itself.
  source: ProjectIdentitySource;
}

export interface ResolveProjectIdentityOptions {
  // Explicit override from config.memory.project.
  configured?: string;
  // Directory the session works in (workspaceRoot()).
  cwd: string;
  // Injected for tests: returns the git remote URL of a directory, or
  // undefined when it is not a git repo or has no remote.
  readGitRemote?: (cwd: string) => string | undefined;
}

const GIT_TIMEOUT_MS = 2_000;

// Length of the hex suffix appended to the folder name in the path fallback.
const HASH_LENGTH = 6;

// Turns a git remote URL into `owner/repo` (or `group/sub/repo` for
// namespaced hosts). Returns undefined when the URL carries no usable path, so
// the caller can fall through to the next rule instead of keying on garbage.
//
// Handles every shape git itself accepts:
// - git@github.com:owner/repo.git
// - https://github.com/owner/repo.git
// - ssh://git@host:22/owner/repo.git
// - git://host/owner/repo
export const normalizeGitRemote = (remote: string): string | undefined => {
  const raw = remote.trim();
  if (!raw) return undefined;

  let pathPart: string;

  // scp-like syntax: [user@]host:path. The colon is not a port separator
  // because there is no "://" before it.
  const scpLike = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/)(.+)$/.exec(raw);
  if (scpLike && !raw.includes("://")) {
    pathPart = scpLike[1];
  } else {
    try {
      const url = new URL(raw);
      pathPart = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }

  const segments = pathPart
    .replace(/\\/g, "/")
    .split("/")
    // Credentials and stray whitespace never belong to a key.
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (!segments.length) return undefined;

  // A trailing ".git" is a git convention, not part of the project identity.
  const last = segments[segments.length - 1].replace(/\.git$/i, "");
  if (!last) return undefined;
  segments[segments.length - 1] = last;

  // At least owner/repo: a single segment (e.g. "https://github.com/") is
  // ambiguous and would collide across hosts.
  if (segments.length < 2) return undefined;

  const key = segments.join("/");

  // Reject the leftovers of something that was never a URL.
  if (/\s/.test(key)) return undefined;

  return key;
};

// Short, stable hash of an absolute path. Six hex chars of SHA-256 are plenty
// to tell two same-named workspaces apart without making the key unreadable.
const pathHash = (absolutePath: string): string =>
  createHash("sha256").update(absolutePath).digest("hex").slice(0, HASH_LENGTH);

// Fallback identity: the folder name plus a hash of the absolute path, so
// /work/cliente-a/api and /work/cliente-b/api never share memories.
const identityFromPath = (cwd: string): ProjectIdentity => {
  const trimmed = cwd.trim();

  if (!trimmed) return { key: "default", source: "path" };

  const absolute = path.resolve(trimmed);
  const base = path.basename(absolute);

  if (!base || absolute === path.sep) return { key: "default", source: "path" };

  return { key: `${base}-${pathHash(absolute)}`, source: "path" };
};

// Reads the origin remote of a directory. Never throws and never writes to the
// process stderr: a missing binary, a non-repo or a repo without origin all
// mean "no remote" for identity purposes.
export const readGitRemote = (cwd: string): string | undefined => {
  try {
    const output = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    const remote = output.trim();

    return remote || undefined;
  } catch {
    return undefined;
  }
};

// Resolves the key that scopes project memories. Order matters: an explicit
// config wins, then the git remote (the same repo cloned anywhere is the same
// project), then the path fallback, which is always usable.
export const resolveProjectIdentity = (options: ResolveProjectIdentityOptions): ProjectIdentity => {
  const configured = options.configured?.trim();
  if (configured) return { key: configured, source: "config" };

  const readRemote = options.readGitRemote ?? readGitRemote;
  try {
    const remote = readRemote(options.cwd);
    const normalized = remote ? normalizeGitRemote(remote) : undefined;
    if (normalized) return { key: normalized, source: "git" };
  } catch {
    // A broken remote reader is not a reason to lose the memory scope.
  }

  return identityFromPath(options.cwd);
};
