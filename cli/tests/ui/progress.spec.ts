import { describe, expect, it } from "vitest";
import {
  colorFor,
  elapsedFor,
  iconFor,
  RESTORED_LIMIT,
  spawnStrip,
  SPAWN_LINGER_MS,
  toSpawnEntry,
  visibleSpawns,
} from "../../src/ui/tui/progress";

const at = (offsetMs: number) => new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();
const now = Date.parse(at(60_000));

describe("visibleSpawns", () => {
  it("shows a running child even without timing data", () => {
    const spawns = [{ id: "s1", agent: "coder", status: "running" }];

    expect(visibleSpawns(spawns, now)).toHaveLength(1);
  });

  it("keeps a settled child during the linger window", () => {
    const spawns = [
      {
        id: "s1",
        agent: "coder",
        status: "done",
        startedAt: at(0),
        finishedAt: at(58_000),
      },
    ];

    expect(visibleSpawns(spawns, now)).toHaveLength(1);
  });

  it("drops a settled child once the linger window passes", () => {
    const spawns = [
      {
        id: "s1",
        agent: "coder",
        status: "done",
        startedAt: at(0),
        finishedAt: new Date(now - SPAWN_LINGER_MS - 1_000).toISOString(),
      },
    ];

    expect(visibleSpawns(spawns, now)).toHaveLength(0);
  });

  it("keeps running children when others have expired", () => {
    const spawns = [
      { id: "old", agent: "a", status: "done", startedAt: at(0), finishedAt: at(1_000) },
      { id: "live", agent: "b", status: "running", startedAt: at(50_000) },
    ];

    expect(visibleSpawns(spawns, now).map((s) => s.id)).toEqual(["live"]);
  });
});

describe("elapsedFor", () => {
  it("counts up while running", () => {
    const spawn = { id: "s", agent: "a", status: "running", startedAt: at(45_000) };

    expect(elapsedFor(spawn, now)).toBe("15s");
  });

  it("freezes once settled", () => {
    const spawn = {
      id: "s",
      agent: "a",
      status: "done",
      startedAt: at(0),
      finishedAt: at(42_000),
    };

    expect(elapsedFor(spawn, now)).toBe("done in 42s");
  });

  it("falls back to the status when there is no start time", () => {
    expect(elapsedFor({ id: "s", agent: "a", status: "error" }, now)).toBe("error");
  });
});

describe("iconFor / colorFor", () => {
  it("maps each lifecycle state", () => {
    expect(iconFor("running")).toBe("◐");
    expect(iconFor("done")).toBe("✓");
    expect(iconFor("error")).toBe("✗");

    expect(colorFor("running")).toBe("cyan");
    expect(colorFor("done")).toBe("green");
    expect(colorFor("error")).toBe("red");
  });
});

describe("toSpawnEntry", () => {
  it("maps a core handle to the row the strip renders", () => {
    expect(
      toSpawnEntry({
        spawnId: "spawn-1",
        agentId: "coder",
        status: "running",
        startedAt: at(0),
      }),
    ).toEqual({
      id: "spawn-1",
      agent: "coder",
      status: "running",
      startedAt: at(0),
      finishedAt: undefined,
    });
  });
});

describe("restored children", () => {
  it("freezes the clock of a finished child from a previous run", () => {
    const spawn = {
      id: "spawn-1",
      agent: "coder",
      status: "done",
      startedAt: at(0),
      finishedAt: at(4_000),
      restored: true,
    };

    // The session is long gone; the elapsed time is the one it took back then.
    expect(elapsedFor({ ...spawn }, now)).toBe("done in 4s");
    expect(elapsedFor({ ...spawn }, now + 3_600_000)).toBe("done in 4s");
  });

  it("calls a child that was running when the session ended interrupted", () => {
    const spawn = {
      id: "spawn-1",
      agent: "coder",
      status: "running",
      startedAt: at(0),
      restored: true,
    };

    expect(elapsedFor(spawn, now)).toBe("interrupted");
  });

  it("still counts the live children of this run", () => {
    const spawn = { id: "spawn-1", agent: "coder", status: "running", startedAt: at(0) };

    expect(elapsedFor(spawn, now)).toBe("60s");
  });
});

describe("spawnStrip", () => {
  const entry = (id: string, startedAt: string, finishedAt = startedAt) => ({
    id,
    agent: "coder",
    status: "done",
    startedAt,
    finishedAt,
  });
  // A child of this run that settled less than SPAWN_LINGER_MS ago.
  const live = (id: string) => entry(id, at(59_000), at(59_500));

  it("lists the live children first, then the restored ones", () => {
    const { rows, hidden } = spawnStrip(
      [live("spawn-live")],
      [entry("spawn-past", at(-2_000))],
      now,
    );

    expect(rows.map((row) => row.id)).toEqual(["spawn-live", "spawn-past"]);
    expect(rows.map((row) => row.restored)).toEqual([false, true]);
    expect(hidden).toBe(0);
  });

  it("never lists the same child twice", () => {
    const child = live("spawn-1");

    const { rows } = spawnStrip([child], [child], now);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.restored).toBe(false);
  });

  it("shows the newest restored children and counts the rest", () => {
    const history = Array.from({ length: RESTORED_LIMIT + 3 }, (_, index) =>
      // Launch order: the newest children were started last.
      entry(`spawn-${index}`, at(index * 1_000)),
    );

    const { rows, hidden } = spawnStrip([], history, now);

    expect(rows).toHaveLength(RESTORED_LIMIT);
    expect(rows[0]?.id).toBe(`spawn-${RESTORED_LIMIT + 2}`);
    expect(hidden).toBe(3);
  });

  it("drops the live children that outlived their linger window", () => {
    const settled = entry("spawn-live", at(0), at(1_000));

    const { rows } = spawnStrip([settled], [], now);

    expect(rows).toEqual([]);
  });
});
