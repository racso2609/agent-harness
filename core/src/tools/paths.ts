import fs from "node:fs";
import path from "node:path";

// Resolves a user/model provided path against the workspace root and rejects
// anything that escapes it. Relative paths are resolved from the workspace;
// absolute paths are accepted only when they live inside it. Symlinks are
// followed with realpath (on the existing ancestor) so a symlink pointing
// outside the workspace cannot be used to bypass the jail.
export const resolveInWorkspace = (workspace: string, raw: string): string => {
  const root = path.resolve(workspace);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);

  const realRoot = realpathOrSelf(root);
  const realCandidate = realpathOrSelf(candidate, realRoot);

  if (!isInside(realRoot, realCandidate)) {
    throw new Error(`Path escapes the workspace: ${raw}`);
  }

  return candidate;
};

// True when target is root itself or a descendant of root.
const isInside = (root: string, target: string): boolean => {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
};

// Resolves symlinks for the deepest existing ancestor, re-appending the
// non-existing tail. Lets writeFile validate a path whose file/parents do
// not exist yet without dropping the realpath protection.
const realpathOrSelf = (target: string, fallback?: string): string => {
  let current = target;
  const tail: string[] = [];

  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return fallback ?? path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
};

// Directory holding the persistent state the harness keeps inside the
// workspace (child report artifacts, ...).
export const HARNESS_DIR_NAME = ".racso-harness";

// Root of the workspace and the jail every tool resolves against: the
// configured tools.workspace, falling back to the process cwd. Always
// absolute, so a relative tools.workspace means the same directory here and in
// resolveInWorkspace instead of depending on the process cwd. Shared by the
// session manager and the tools so both agree on what "the workspace" is.
export const workspaceRoot = (workspace?: string): string =>
  path.resolve(workspace ?? process.cwd());

// Absolute directory of the child report artifacts of one session. It lives
// inside the workspace on purpose: the parent's tools are jailed there, so an
// artifact under the harness home would be a path the parent could not read.
export const spawnArtifactsDir = (workspace: string, sessionId: string): string =>
  path.join(workspaceRoot(workspace), HARNESS_DIR_NAME, "artifacts", sessionId);

// Characters an id may use to become a path segment: letters, digits, dot,
// underscore and dash, with at least one of the first three, so the bare "."
// and ".." names (dots only) never pass. The ids the harness generates are
// `crypto.randomUUID()` spawns and `session-<uuid>` sessions, so both fit,
// while separators and every other special character are rejected.
const ID_PATTERN = /^(?=.*[A-Za-z0-9_-])[A-Za-z0-9._-]+$/;

// Absolute path of one child's report artifact. The ids come from the session
// manager and end up as path segments, so they are only accepted when they
// match ID_PATTERN, which rules out a separator and the bare "." / ".." names
// that would place the artifact outside the session directory.
export const spawnArtifactPath = (
  workspace: string,
  sessionId: string,
  spawnId: string,
): string => {
  for (const id of [sessionId, spawnId]) {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid session or spawn id for a report artifact: ${id}`);
    }
  }

  return path.join(spawnArtifactsDir(workspace, sessionId), `${spawnId}.md`);
};

// Resolves symlinks in the EXISTING part of target and appends the components
// that do not exist yet, without ever re-anchoring them inside the root. Unlike
// realpathOrSelf it follows the real path of every existing ancestor: a symlink
// at any level is expanded, so a directory that does not exist yet under a
// symlinked parent resolves to where it would really be created.
const realExistingPath = (target: string): string => {
  const missing: string[] = [];
  let current = path.resolve(target);

  while (!fs.existsSync(current)) {
    const name = path.basename(current);
    // A tail component that is not a plain name ("..", ".", "") cannot be
    // appended literally: joining it re-anchors the path inside the root
    // instead of describing where it really lands. Refusing the resolution
    // leaves the path outside the root, which is the safe answer for a
    // target that cannot be built anyway.
    if (name === ".." || name === "." || name === "") return path.resolve("/");
    missing.unshift(name);
    const parent = path.dirname(current);
    // Nothing exists up to the filesystem root: nothing left to resolve.
    if (parent === current) return path.resolve(target);
    current = parent;
  }

  return path.join(fs.realpathSync(current), ...missing);
};

// True when target would really be created inside the real workspace, symlinks
// included. A plain prefix comparison against the unresolved root is not
// enough: a symlinked directory inside the workspace can point outside it while
// the path itself still starts with the root. The caller must pass the root
// already resolved (workspaceRoot), so root and target are compared in the same
// terms; an existing target must resolve inside the root as its own realpath,
// and a missing one inside root+tail, so no component may escape.
export const isInsideRealWorkspace = (workspace: string, target: string): boolean => {
  // The root is resolved for real too: on macOS /var is a symlink to
  // /private/var, so comparing a /private root against a /var target would
  // read as an escape for every artifact and withhold every path.
  const realRoot = realExistingPath(workspace);
  const resolved = fs.existsSync(target) ? fs.realpathSync(target) : realExistingPath(target);

  return isInside(realRoot, resolved);
};

// True when target is root itself or a descendant of root, following
// symlinks the way resolveInWorkspace does, so a caller that publishes a path
// outside the jail announces exactly what the tools will refuse to read.
export const isInsideWorkspace = (workspace: string, target: string): boolean => {
  const realRoot = realpathOrSelf(path.resolve(workspace));
  const realTarget = realpathOrSelf(path.resolve(target), realRoot);

  return isInside(realRoot, realTarget);
};
