import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ancestorPids,
  findTagged,
  isOrphaned,
  listProcesses,
  sweepOrphans,
  type ProcessRow,
} from "./processTable";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForDeath = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return !isAlive(pid);
};

// A process that outlives the assertions until it is killed on purpose.
const spawnLongLived = (title: string, extraEnv: Record<string, string> = {}) => {
  const script = title
    ? `process.title = ${JSON.stringify(title)}; setInterval(() => {}, 1000);`
    : "setInterval(() => {}, 1000);";

  return spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    env: { ...process.env, ...extraEnv },
  });
};

const kill = (child: ReturnType<typeof spawn>): Promise<unknown> => {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  return exited;
};

// Polls until the file exists, so a test never reads a pid that was not
// written yet.
const waitForFile = async (file: string, timeoutMs = 5000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`timed out waiting for ${file}`);
};

// A parent that spawns a grandchild carrying `tag` in its process title, and
// reports the pid of that grandchild through a file. Killing the parent leaves
// a real orphan behind, which is what the sweep has to find.
//
// The title travels through a file instead of the parent's argv on purpose: a
// title in the parent's command line would make the parent itself match the
// marker, and the test would then be sweeping the wrong process.
const spawnOrphanableGrandchild = async (
  tag: string,
): Promise<{ parent: ReturnType<typeof spawn>; grandchild: number; dir: string }> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "racso-sweep-"));
  const titleFile = path.join(dir, "title.txt");
  const pidFile = path.join(dir, "grandchild.pid");
  writeFileSync(titleFile, `fixture-grandchild:${tag}`, "utf8");

  const parentScript = `
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const [titleFile, pidFile] = process.argv.slice(1);
const title = readFileSync(titleFile, "utf8");
const child = spawn(
  process.execPath,
  ["-e", "process.title = process.argv[1]; setInterval(() => {}, 1000);", title],
  { stdio: "ignore", env: { ...process.env } },
);
writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
`;

  const parent = spawn(process.execPath, ["-e", parentScript, titleFile, pidFile], {
    stdio: "ignore",
    env: { ...process.env, FIXTURE_TAG: tag },
  });

  const grandchild = Number(await waitForFile(pidFile));
  return { parent, grandchild, dir };
};

describe("listProcesses", () => {
  it("lists the whole machine, not only the processes attached to a terminal", () => {
    const rows = listProcesses();
    const own = rows.find((row) => row.pid === process.pid);

    expect(own).toBeDefined();
    expect(own?.ppid).toBe(process.ppid);
    // A run that only saw tty processes would be a dozen rows on macOS, and every
    // sweep built on it would come back empty without ever failing.
    expect(rows.length).toBeGreaterThan(20);
  });

  it("includes the environment in the command it reports", async () => {
    const tag = `own-env-${process.pid}-${Date.now()}`;
    const child = spawnLongLived("", { FIXTURE_TAG: tag });

    try {
      const row = listProcesses().find((process_) => process_.pid === child.pid);
      expect(row?.command).toContain(`FIXTURE_TAG=${tag}`);
    } finally {
      await kill(child);
    }
  });
});

describe("findTagged", () => {
  it("finds a live child by its environment and stops finding it once it is dead", async () => {
    const tag = `tagged-env-${process.pid}-${Date.now()}`;
    const child = spawnLongLived("", { FIXTURE_TAG: tag });

    try {
      const found = findTagged(listProcesses(), tag);

      expect(found.map((process_) => process_.pid)).toContain(child.pid);
      expect(found.find((process_) => process_.pid === child.pid)?.ppid).toBe(process.pid);
    } finally {
      await kill(child);
    }

    await waitForDeath(child.pid as number);
    expect(findTagged(listProcesses(), tag)).toEqual([]);
  });

  it("finds a grandchild by its process title, which carries no environment marker", async () => {
    const tag = `tagged-title-${process.pid}-${Date.now()}`;
    const child = spawnLongLived(`fixture-grandchild:${tag}`);

    try {
      const found = findTagged(listProcesses(), tag);

      expect(found.map((process_) => process_.pid)).toContain(child.pid);
    } finally {
      await kill(child);
    }

    await waitForDeath(child.pid as number);
    expect(findTagged(listProcesses(), tag)).toEqual([]);
  });

  it("leaves out the ancestors of the runner, which inherit the same environment", () => {
    const tag = `ancestor-${process.pid}-${Date.now()}`;
    const rows: ProcessRow[] = [
      { pid: process.pid, ppid: process.ppid, command: `node FIXTURE_TAG=${tag}` },
      { pid: process.ppid, ppid: 1, command: `sh FIXTURE_TAG=${tag}` },
      { pid: 4242, ppid: 1, command: `node fixture-grandchild:${tag}` },
    ];

    const found = findTagged(rows, tag);

    expect([...ancestorPids(rows)]).toEqual([process.pid, process.ppid, 1]);
    expect(found).toEqual([{ pid: 4242, ppid: 1 }]);
  });
});

describe("isOrphaned", () => {
  const rows: ProcessRow[] = [
    { pid: 100, ppid: 1, command: "server" },
    { pid: 200, ppid: 100, command: "grandchild" },
  ];

  it("reports a process re-parented to init as orphaned", () => {
    expect(isOrphaned(300, 1, rows)).toBe(true);
  });

  it("reports a process whose parent disappeared as orphaned", () => {
    expect(isOrphaned(200, 999, [{ pid: 200, ppid: 999, command: "grandchild" }])).toBe(true);
  });

  it("keeps a process whose parent is still alive out of the sweep", () => {
    expect(isOrphaned(200, 100, rows)).toBe(false);
  });
});

describe("sweepOrphans", () => {
  it("kills a real orphaned grandchild and reports it", async () => {
    const tag = `sweep-orphan-${process.pid}-${Date.now()}`;
    const { parent, grandchild, dir } = await spawnOrphanableGrandchild(tag);

    try {
      // While the parent lives the grandchild is not abandoned, so the sweep
      // must report it as parented and leave it running: killing it here would
      // SIGKILL a server in the middle of its own `stopChildren()`.
      const before = sweepOrphans(listProcesses(), tag);
      expect(before.orphans).toEqual([]);
      expect(before.parented.map((process_) => process_.pid)).toContain(grandchild);
      expect(isAlive(grandchild)).toBe(true);

      parent.kill("SIGKILL");
      await waitForDeath(parent.pid as number);
      expect(await waitForDeath(grandchild, 0)).toBe(false);

      const after = sweepOrphans(listProcesses(), tag);
      expect(after.orphans.map((process_) => process_.pid)).toContain(grandchild);
      expect(await waitForDeath(grandchild)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already swept.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a tagged process with a live parent alone", async () => {
    const tag = `sweep-parented-${process.pid}-${Date.now()}`;
    const child = spawnLongLived("", { FIXTURE_TAG: tag });

    try {
      const { orphans, parented } = sweepOrphans(listProcesses(), tag);

      expect(orphans).toEqual([]);
      expect(parented.map((process_) => process_.pid)).toContain(child.pid);
      expect(isAlive(child.pid as number)).toBe(true);
    } finally {
      await kill(child);
    }
  });

  // The sweep re-checks a pid with signal 0 before the SIGKILL, the way the
  // fixture does. A row that is already gone must not be reported as swept:
  // reporting it would claim a kill that never happened, and the pid may
  // already belong to an unrelated process.
  it("does not report a pid that is already gone", () => {
    const tag = `sweep-gone-${process.pid}-${Date.now()}`;
    const rows: ProcessRow[] = [
      { pid: 999_999, ppid: 1, command: `node fixture-grandchild:${tag}` },
    ];

    const { orphans, parented } = sweepOrphans(rows, tag);

    expect(orphans).toEqual([]);
    expect(parented).toEqual([]);
  });

  it("ignores a process that does not carry the tag", async () => {
    const tag = `sweep-own-${process.pid}-${Date.now()}`;
    const stranger = spawnLongLived("", { FIXTURE_TAG: `other-${tag}` });

    try {
      const { orphans, parented } = sweepOrphans(listProcesses(), tag);

      expect(orphans).toEqual([]);
      expect(parented).toEqual([]);
      expect(isAlive(stranger.pid as number)).toBe(true);
    } finally {
      await kill(stranger);
    }
  });
});

describe("findTagged markers", () => {
  // Measured, not assumed: `ps -A -E` prints the environment of a live child,
  // but stops printing it for a process that was re-parented to init. The
  // title survives because it lives in the command line, which `ps` always
  // shows. That is why the sweep matches both markers and why an orphaned
  // grandchild is only ever found by its title.
  it("finds a live child by its environment and an orphaned grandchild by its title", async () => {
    const tag = `markers-${process.pid}-${Date.now()}`;
    const child = spawnLongLived("", { FIXTURE_TAG: tag });
    const { parent, grandchild, dir } = await spawnOrphanableGrandchild(tag);

    try {
      parent.kill("SIGKILL");
      await waitForDeath(parent.pid as number);
      expect(await waitForDeath(grandchild, 0)).toBe(false);

      const rows = listProcesses();
      const childRow = rows.find((row) => row.pid === child.pid);
      const orphanRow = rows.find((row) => row.pid === grandchild);

      // A live direct child is found by the environment variable.
      expect(childRow?.command).toContain(`FIXTURE_TAG=${tag}`);
      // The orphaned grandchild is found by its title, and its environment is
      // no longer printed at all.
      expect(orphanRow?.command).toContain(`fixture-grandchild:${tag}`);
      expect(orphanRow?.command).not.toContain(`FIXTURE_TAG=${tag}`);

      const found = findTagged(rows, tag).map((process_) => process_.pid);
      expect(found).toContain(child.pid);
      expect(found).toContain(grandchild);
    } finally {
      await kill(child);
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
