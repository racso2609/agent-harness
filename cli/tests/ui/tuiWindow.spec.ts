import { describe, expect, it } from "vitest";
import { windowOf } from "../../src/ui/tui/entries";
import { GAP } from "../../src/ui/tui/layout";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `L${index}`);

// Every case asserts on the resolved entries themselves (line, absolute index
// and gap), which is exactly what the render consumes. No ink, no TTY.
describe("windowOf", () => {
  it("resolves a transcript that fits: absolute indexes from zero, first entry flush", () => {
    const window = windowOf(lines(3), 60);

    expect(window.start).toBe(0);
    expect(window.entries).toHaveLength(3);
    expect(window.entries[0]).toEqual({ line: "L0", absolute: 0, gap: 0 });
    expect(window.entries[2]!.gap).toBe(GAP);
  });

  it("resolves a scrolled transcript with absolute indexes and air above its first entry", () => {
    const window = windowOf(lines(62), 60);

    expect(window.start).toBe(2);
    expect(window.entries).toHaveLength(60);
    // The first visible entry is not the first of the transcript, so it keeps
    // its air even though it sits at position 0 of the window.
    expect(window.entries[0]).toEqual({ line: "L2", absolute: 2, gap: GAP });
    expect(window.entries[59]!.absolute).toBe(61);
    expect(window.entries[59]!.line).toBe("L61");
  });

  it("returns an empty window for an empty transcript", () => {
    const window = windowOf(lines(0), 60);

    expect(window.start).toBe(0);
    expect(window.entries).toEqual([]);
  });

  it("keeps every entry when the size is larger than the transcript", () => {
    const window = windowOf(lines(3), 60);

    expect(window.start).toBe(0);
    expect(window.entries.map((entry) => entry.line)).toEqual(["L0", "L1", "L2"]);
  });

  it("does not throw at size zero: the whole tail from start is returned", () => {
    // Math.max(0, lines.length - 0) is the length, so slice(length) is empty and
    // the window is start === 3 with no entries rather than an error.
    const window = windowOf(lines(3), 0);

    expect(window.start).toBe(3);
    expect(window.entries).toEqual([]);
  });
});
