import { describe, expect, it } from "vitest";
import { collectProcessTree, killProcessTree, type KillTreeDeps } from "../../src/mcp/killTree";

// A fake process table: pid -> children. Nothing here touches the real system,
// so the walk is asserted exactly.
const tree = (table: Record<number, number[]>) => {
  const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const gone = new Set<number>();
  const sleeps: number[] = [];

  const deps: KillTreeDeps = {
    kill: (pid, signal) => {
      signalled.push({ pid, signal });
      if (signal === "SIGKILL") gone.add(Math.abs(pid));
    },
    children: (pid) => table[pid] ?? [],
    pgid: () => 42,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    // Children stay alive on SIGTERM so the escalation has to happen.
    alive: (pid) => !gone.has(pid),
  };

  return { deps, signalled, sleeps };
};

describe("collectProcessTree", () => {
  it("lists every pid of the tree, deepest first", () => {
    const order = collectProcessTree(
      10,
      (pid) => ({ 10: [11, 12], 11: [13], 12: [], 13: [] })[pid] ?? [],
    );

    expect(order.indexOf(13)).toBeLessThan(order.indexOf(11));
    expect(order.indexOf(11)).toBeLessThan(order.indexOf(10));
    expect(order.indexOf(12)).toBeLessThan(order.indexOf(10));
    expect(order).toHaveLength(4);
    expect(order[order.length - 1]).toBe(10);
  });

  it("returns just the root for a process with no children", () => {
    expect(collectProcessTree(10, () => [])).toEqual([10]);
  });

  it("does not loop forever on a parent cycle", () => {
    const order = collectProcessTree(10, (pid) => ({ 10: [11], 11: [10] })[pid] ?? []);

    expect(order.sort()).toEqual([10, 11]);
  });
});

describe("killProcessTree", () => {
  it("sends SIGTERM to every pid of the tree, children before parents", async () => {
    const { deps, signalled } = tree({ 10: [11], 11: [12] });

    await killProcessTree(10, deps, 0);

    expect(signalled).toEqual([
      { pid: 12, signal: "SIGTERM" },
      { pid: 11, signal: "SIGTERM" },
      { pid: 10, signal: "SIGTERM" },
      { pid: 12, signal: "SIGKILL" },
      { pid: 11, signal: "SIGKILL" },
      { pid: 10, signal: "SIGKILL" },
    ]);
  });

  it("does not signal the process group when the root is not its leader", async () => {
    const { deps, signalled } = tree({ 10: [11] });
    deps.pgid = (pid) => (pid === 10 ? 99 : undefined);

    await killProcessTree(10, deps, 0);

    expect(signalled.some((entry) => entry.pid < 0)).toBe(false);
    expect(signalled.map((entry) => entry.pid)).toEqual([11, 10, 11, 10]);
  });

  it("signals the process group when the root leads it", async () => {
    const { deps, signalled } = tree({ 10: [] });
    deps.pgid = (pid) => pid;

    await killProcessTree(10, deps, 0);

    expect(signalled).toContainEqual({ pid: -10, signal: "SIGTERM" });
    expect(signalled).toContainEqual({ pid: -10, signal: "SIGKILL" });
  });

  it("waits the grace period before escalating to SIGKILL", async () => {
    const { deps, sleeps } = tree({ 10: [] });

    await killProcessTree(10, deps, 100);

    expect(sleeps.length).toBeGreaterThan(0);
  });
});
