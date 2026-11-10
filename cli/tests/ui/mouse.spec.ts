// SGR mouse vocabulary. The transcript used to read the wheel out of the raw
// chunk with its own regex; that regex now lives in `mouse.ts` and knows the
// whole table, because a click is about to mean "cancel the running turn".
// Every row of that table is asserted here as a plain object: no ink, no TTY,
// and the coordinates are literal so an off-by-one jumps out.

import { describe, expect, it } from "vitest";
import { createHoverStore, parseMouseReports } from "../../src/ui/tui/mouse";

// SGR reports are 1-based, so the coordinates below are deliberately not the
// row and column of anything on screen: column 1 and row 1 must survive the
// trip unchanged.
const report = (button: string, col: number, row: number, terminator = "M") =>
  `\u001b[<${button};${col};${row}${terminator}`;

describe("parseMouseReports", () => {
  it("reads a left press", () => {
    expect(parseMouseReports(report("0", 1, 1))).toEqual([
      { button: "left", phase: "press", col: 1, row: 1 },
    ]);
  });

  it("reads middle and right presses", () => {
    expect(parseMouseReports(report("1", 7, 3))).toEqual([
      { button: "middle", phase: "press", col: 7, row: 3 },
    ]);
    expect(parseMouseReports(report("2", 12, 4))).toEqual([
      { button: "right", phase: "press", col: 12, row: 4 },
    ]);
  });

  it("reads a release sent with the lowercase terminator", () => {
    expect(parseMouseReports(report("0", 33, 9, "m"))).toEqual([
      { button: "left", phase: "release", col: 33, row: 9 },
    ]);
  });

  it("reads a drag as a move with the button held", () => {
    expect(parseMouseReports(report("32", 21, 5))).toEqual([
      { button: "left", phase: "move", col: 21, row: 5 },
    ]);
  });

  it("reads bare motion with the lowercase terminator as a move", () => {
    // 35 with `m` is what `?1003h` sends: the mouse moved, nothing is held.
    expect(parseMouseReports(report("35", 40, 8, "m"))).toEqual([
      { button: "other", phase: "move", col: 40, row: 8 },
    ]);
  });

  it("reads motion with the uppercase terminator as a move too", () => {
    expect(parseMouseReports(report("35", 41, 8))).toEqual([
      { button: "other", phase: "move", col: 41, row: 8 },
    ]);
  });

  it("reads both wheel notches as presses", () => {
    expect(parseMouseReports(report("64", 5, 6))).toEqual([
      { button: "wheel-up", phase: "press", col: 5, row: 6 },
    ]);
    expect(parseMouseReports(report("65", 6, 7))).toEqual([
      { button: "wheel-down", phase: "press", col: 6, row: 7 },
    ]);
  });

  it("keeps an unknown button as other instead of dropping it", () => {
    expect(parseMouseReports(report("128", 2, 3))).toEqual([
      { button: "other", phase: "press", col: 2, row: 3 },
    ]);
  });

  it("keeps every report when the terminal batches three in one chunk", () => {
    expect(parseMouseReports(report("64", 1, 1) + report("0", 2, 2) + report("65", 3, 3))).toEqual([
      { button: "wheel-up", phase: "press", col: 1, row: 1 },
      { button: "left", phase: "press", col: 2, row: 2 },
      { button: "wheel-down", phase: "press", col: 3, row: 3 },
    ]);
  });

  it("returns nothing for a chunk without reports, a bare escape included", () => {
    expect(parseMouseReports("\u001b[Aabc\u001b")).toEqual([]);
    expect(parseMouseReports("")).toEqual([]);
  });

  it("finds the report inside a chunk that also carries keys", () => {
    expect(parseMouseReports("a" + report("0", 4, 10) + "\u001b[A")).toEqual([
      { button: "left", phase: "press", col: 4, row: 10 },
    ]);
  });

  it("does not carry state between calls", () => {
    // `?1003h` delivers one chunk per pixel of movement, so a half report left over
    // from one call must never be completed by the next one.
    expect(parseMouseReports("\u001b[<0;5;")).toEqual([]);
    expect(parseMouseReports("5M")).toEqual([]);
  });
});

// The store the pointer writes into. With `?1003h` the terminal reports tens of
// motion events per second and almost all of them land where the answer does
// not change; a notification per report would be a render per pixel, so the
// only interesting behaviour of this store is when it stays quiet.
describe("createHoverStore", () => {
  it("starts on nothing", () => {
    expect(createHoverStore().get()).toBeNull();
  });

  it("does not notify when the value is set to what it already is", () => {
    const store = createHoverStore();
    let notified = 0;

    store.subscribe(() => notified++);
    store.set(2);
    store.set(2);
    store.set(2);

    expect(notified).toBe(1);
  });

  it("does not notify for null over null", () => {
    const store = createHoverStore();
    let notified = 0;

    store.subscribe(() => notified++);
    store.set(null);
    store.set(null);

    expect(notified).toBe(0);
  });

  it("notifies once for a different value, and once for clearing it", () => {
    const store = createHoverStore();
    let notified = 0;

    store.subscribe(() => notified++);
    store.set(1);
    store.set(null);

    expect(notified).toBe(2);
  });

  it("reports the last value written", () => {
    const store = createHoverStore();

    store.set(3);
    expect(store.get()).toBe(3);

    store.set(null);
    expect(store.get()).toBeNull();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createHoverStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);

    store.set(1);
    unsubscribe();
    store.set(2);
    store.set(null);

    expect(notified).toBe(1);
  });

  it("keeps the other subscribers when one leaves mid-notification", () => {
    const store = createHoverStore();
    const heard: string[] = [];
    const first = store.subscribe(() => {
      heard.push("first");
      first();
    });

    store.subscribe(() => heard.push("second"));
    store.set(4);
    store.set(5);

    expect(heard).toEqual(["first", "second", "second"]);
  });
});
