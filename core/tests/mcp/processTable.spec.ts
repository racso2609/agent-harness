import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ancestorPids,
  findTagged,
  isOrphaned,
  listProcesses,
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
