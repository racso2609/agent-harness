import { describe, expect, it } from "vitest";
import {
  colorFor,
  elapsedFor,
  iconFor,
  PROMPT_COLUMNS,
  promptFor,
  RESTORED_LIMIT,
  spawnStrip,
  SPAWN_LINGER_MS,
  stoppable,
  stripRowAt,
  toSpawnEntry,
  visibleSpawns,
} from "../../src/ui/tui/progress";
import { truncateCell } from "../../src/ui/tui/layout";

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

  it("freezes a cancelled child the same way as a done one", () => {
    const spawn = {
      id: "s",
      agent: "a",
      status: "cancelled",
      startedAt: at(0),
      finishedAt: at(12_000),
    };

    expect(elapsedFor(spawn, now)).toBe("cancelled in 12s");
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
    expect(iconFor("cancelled")).toBe("⊘");

    expect(colorFor("running")).toBe("cyan");
    expect(colorFor("done")).toBe("green");
    expect(colorFor("error")).toBe("red");
    expect(colorFor("cancelled")).toBe("yellow");
  });
});

describe("toSpawnEntry", () => {
  it("maps a core handle to the row the strip renders", () => {
    expect(
      toSpawnEntry({
        spawnId: "spawn-1",
        agentId: "coder",
        prompt: "fix the login bug",
        status: "running",
        startedAt: at(0),
      }),
    ).toEqual({
      id: "spawn-1",
      agent: "coder",
      prompt: "fix the login bug",
      status: "running",
      startedAt: at(0),
      finishedAt: undefined,
    });
  });

  it("keeps two children of the same agent distinguishable", () => {
    const first = toSpawnEntry({
      spawnId: "spawn-1",
      agentId: "coder",
      prompt: "fix the login bug",
      status: "running",
      startedAt: at(0),
    });
    const second = toSpawnEntry({
      spawnId: "spawn-2",
      agentId: "coder",
      prompt: "add the logout test",
      status: "running",
      startedAt: at(0),
    });

    expect(second.prompt).not.toBe(first.prompt);
  });
});
describe("promptFor", () => {
  it("keeps a short prompt whole", () => {
    const spawn = { id: "s", agent: "coder", prompt: "fix the login bug", status: "running" };

    expect(promptFor(spawn)).toBe("fix the login bug");
  });

  it("clips a long prompt to the reserved columns, marking the cut", () => {
    const spawn = {
      id: "s",
      agent: "coder",
      prompt: "read every file of the repository and then refactor the whole parser".repeat(5),
      status: "running",
    };
    const painted = promptFor(spawn);

    expect(painted).toHaveLength(PROMPT_COLUMNS);
    expect(painted.endsWith("…")).toBe(true);
  });

  it("folds a prompt written across several lines onto one", () => {
    const spawn = {
      id: "s",
      agent: "coder",
      prompt: "  fix the\n  login bug\n\tand add a test ",
      status: "running",
    };

    // One row per child is a rule of the strip: a newline here would push the
    // row onto a second terminal line and desynchronise the mouse hit-test.
    expect(promptFor(spawn)).toBe(truncateCell("fix the login bug and add a test", PROMPT_COLUMNS));
    expect(promptFor(spawn)).not.toContain("\n");
  });

  it("never leaves a long multi-line prompt with a line break", () => {
    const spawn = {
      id: "s",
      agent: "coder",
      prompt: Array.from({ length: 40 }, (_, index) => `step ${index} with detail`).join("\n"),
      status: "running",
    };
    const painted = promptFor(spawn);

    expect(painted.split("\n")).toHaveLength(1);
    expect(painted.length).toBeLessThanOrEqual(PROMPT_COLUMNS);
    expect(painted.startsWith("step 0 with detail step")).toBe(true);
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

describe("stripRowAt", () => {
  // A strip starting at viewport row 2 with three children: top border at 2,
  // children at 3, 4 and 5, bottom border at 6, the "+N older" row at 7.
  const geometry = { top: 2, children: 3, hasCounter: false };
  // SGR rows are 1-based, so the first child row in a report is top + 2.
  const firstChild = geometry.top + 2;

  it("ignores the top border", () => {
    expect(stripRowAt({ row: firstChild - 1 }, geometry)).toBeNull();
  });

  it("maps the first child row to index 0", () => {
    expect(stripRowAt({ row: firstChild }, geometry)).toBe(0);
  });

  it("maps the last child row to children - 1", () => {
    expect(stripRowAt({ row: firstChild + geometry.children - 1 }, geometry)).toBe(
      geometry.children - 1,
    );
  });

  it("ignores the bottom border", () => {
    expect(stripRowAt({ row: firstChild + geometry.children }, geometry)).toBeNull();
  });

  it("ignores the +N older counter row", () => {
    expect(stripRowAt({ row: firstChild + geometry.children + 1 }, geometry)).toBeNull();
  });

  it("ignores a row well below the strip", () => {
    expect(stripRowAt({ row: 40 }, geometry)).toBeNull();
  });

  it("ignores row 0 and negative rows", () => {
    expect(stripRowAt({ row: 0 }, geometry)).toBeNull();
    expect(stripRowAt({ row: -3 }, geometry)).toBeNull();
  });

  it("moves the hit exactly one row when the strip moves one row", () => {
    // The coherence test: if the geometry and this arithmetic ever drifted apart,
    // moving the strip down would stop matching the row the user clicked.
    for (let k = firstChild; k < firstChild + geometry.children; k++) {
      expect(stripRowAt({ row: k + 1 }, { ...geometry, top: geometry.top + 1 })).toBe(
        stripRowAt({ row: k }, geometry),
      );
    }
  });

  it("ignores the strip entirely when it paints no children", () => {
    const empty = { top: 2, children: 0, hasCounter: false };

    expect(stripRowAt({ row: firstChild }, empty)).toBeNull();
  });
});

describe("stoppable", () => {
  const row = (status: string, restored = false) => ({
    id: "spawn-1",
    agent: "coder",
    status,
    restored,
  });

  it("stops a running child of this process", () => {
    expect(stoppable(row("running"))).toBe(true);
  });

  it("never offers a settled child", () => {
    expect(stoppable(row("done"))).toBe(false);
    expect(stoppable(row("error"))).toBe(false);
    expect(stoppable(row("cancelled"))).toBe(false);
  });

  it("never offers a child restored from a previous run", () => {
    expect(stoppable(row("running", true))).toBe(false);
  });
});
