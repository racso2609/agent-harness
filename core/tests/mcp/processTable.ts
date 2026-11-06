import { execFileSync } from "node:child_process";

// Pids re-parented to init (pid 1) once their parent died, as a later `ps`
// reports them. Linux may hand them to a sub-reaper instead, hence the
// `isOrphaned` check also treating a vanished parent as an orphan.
const REPARENTED_PPID = 1;

// `ps -A -E` prints the environment of every process after its command line.
// The output is over a megabyte on a busy machine, and execFileSync defaults
// to a 1 MB buffer that kills the child with ENOBUFS long before the list is
// read: the only symptom is an exception, or, when it is swallowed, a sweep
// that quietly sees nothing.
const PS_MAX_BUFFER = 64 * 1024 * 1024;

export interface ProcessRow {
  pid: number;
  ppid: number;
  // Command line plus environment, exactly as `ps -E` joined them.
  command: string;
}

export interface TaggedProcess {
  pid: number;
  ppid: number;
}

// Every live process on the machine, with its command line and environment.
//
// `-A` is not optional: without it `ps` only lists processes attached to a
// terminal, a dozen instead of hundreds on macOS, and every sweep built on it
// comes back empty and never fails.
export const listProcesses = (): ProcessRow[] => {
  const output = execFileSync("ps", ["-A", "-E", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: PS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });

  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;

    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }

  return rows;
};

// Pids of `rows` plus all of their ancestors: the test runner, its shell and
// everything above them carry the same environment as the fixtures, so they
// would match a sweep that did not leave them out.
export const ancestorPids = (rows: ProcessRow[], root: number = process.pid): Set<number> => {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));

  const ancestors = new Set<number>();
  let current: number | undefined = root;
  while (current !== undefined && current > 0 && !ancestors.has(current)) {
    ancestors.add(current);
    current = parents.get(current);
  }

  return ancestors;
};

// Every process carrying the marker of a fixture, whether as the environment
// variable `FIXTURE_TAG=<tag>` or as the title `fixture-grandchild:<tag>`.
//
// Both forms are matched on purpose: a server passes the tag down in its
// environment, while a grandchild stamps it in its process title, and a leak
// is only findable if either one is enough. Ancestors of `root` are left out
// because they inherit the same environment.
export const findTagged = (
  rows: ProcessRow[],
  tag: string,
  root: number = process.pid,
): TaggedProcess[] => {
  const ancestors = ancestorPids(rows, root);
  const markers = [`FIXTURE_TAG=${tag}`, `fixture-grandchild:${tag}`];

  return rows
    .filter((row) => !ancestors.has(row.pid))
    .filter((row) => markers.some((marker) => row.command.includes(marker)))
    .map(({ pid, ppid }) => ({ pid, ppid }));
};

// True when a process no longer has the parent it was born with: its parent
// is init, or the pid it was parented to is gone from the process table.
export const isOrphaned = (pid: number, ppid: number, rows: ProcessRow[]): boolean => {
  if (pid === ppid || ppid <= REPARENTED_PPID) return true;

  return !rows.some((row) => row.pid === ppid);
};
