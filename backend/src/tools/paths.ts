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
