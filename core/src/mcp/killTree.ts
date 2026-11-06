import { execFileSync } from "node:child_process";

// How long a process gets to honour SIGTERM before SIGKILL.
export const KILL_GRACE_MS = 500;

// The only things this helper needs from the outside world. Injectable so the
// walking logic can be tested without spawning anything.
export interface KillTreeDeps {
  // Signal one pid. Any error means "already gone" and is ignored.
  kill: (pid: number, signal: NodeJS.Signals) => void;
  // Direct children of a pid, empty when it has none or cannot be inspected.
  children: (pid: number) => number[];
  // Real group id of a pid, undefined when the platform cannot tell.
  pgid: (pid: number) => number | undefined;
  sleep: (ms: number) => Promise<void>;
  alive: (pid: number) => boolean;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// `ps -A -o pid= -o ppid=` lists every process with its parent, which works
// on macOS and Linux alike (unlike /proc, which macOS lacks).
const listChildren = (pid: number): number[] => {
  try {
    const output = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const children: number[] = [];
    for (const line of output.split("\n")) {
      const [childPid, parentPid] = line.trim().split(/\s+/);
      if (Number(parentPid) === pid && Number(childPid) > 0) children.push(Number(childPid));
    }
    return children;
  } catch {
    return [];
  }
};

// `getpgid` exists on every platform Node supports but is missing from
// @types/node, hence the narrow cast instead of a global declaration.
const getpgid = (process as { getpgid?: (pid: number) => number }).getpgid;

const realPgid = (pid: number): number | undefined => {
  try {
    return getpgid?.call(process, pid);
  } catch {
    return undefined;
  }
};

// Default wiring against the real process table.
export const defaultKillTreeDeps: KillTreeDeps = {
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  children: listChildren,
  pgid: realPgid,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alive: isAlive,
};

// Pids of the process tree rooted at `root`, deepest first: every pid appears
// after all of its descendants, so signalling in order stops children before
// they can be re-parented and escape.
export const collectProcessTree = (root: number, children: (pid: number) => number[]): number[] => {
  const order: number[] = [];
  const seen = new Set<number>([root]);

  const visit = (pid: number): void => {
    for (const child of children(pid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      visit(child);
    }
    order.push(pid);
  };

  visit(root);
  return order;
};

// Signals a whole process tree with SIGTERM and escalates to SIGKILL for
// whatever is still alive after the grace period. When `root` leads its own
// process group the group is signalled too, which is cheaper and also covers
// processes spawned while the tree was being walked.
export const killProcessTree = async (
  root: number,
  deps: KillTreeDeps = defaultKillTreeDeps,
  graceMs = KILL_GRACE_MS,
): Promise<void> => {
  const tree = collectProcessTree(root, deps.children);
  const ownsGroup = deps.pgid(root) === root;

  // Deepest first: a grandchild ignoring SIGTERM must not keep its parent
  // alive, and a killed parent cannot respawn it.
  for (const pid of tree) deps.kill(pid, "SIGTERM");
  if (ownsGroup) deps.kill(-root, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && tree.some((pid) => deps.alive(pid))) {
    await deps.sleep(25);
  }

  for (const pid of tree) deps.kill(pid, "SIGKILL");
  if (ownsGroup) deps.kill(-root, "SIGKILL");
};
