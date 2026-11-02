import { describe, expect, it } from "vitest";
import { collapse, estimateLines, PREVIEW_LINES, tail } from "../../src/ui/tui/collapse";

const long = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("estimateLines", () => {
  it("wraps long lines by width", () => {
    expect(estimateLines("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
  });

  it("keeps empty lines and newlines", () => {
    expect(estimateLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("returns nothing for empty text", () => {
    expect(estimateLines("", 10)).toEqual([]);
  });
});

describe("tail", () => {
  it("keeps the last lines with a cut marker", () => {
    const result = tail(["1", "2", "3", "4"], 2);

    expect(result.split("\n")).toEqual(["…", "3", "4"]);
  });

  it("does not mark anything when it fits", () => {
    expect(tail(["1", "2"], 5)).toBe("1\n2");
  });
});

describe("collapse", () => {
  const base = { width: Infinity, expanded: false, role: "reasoning" as const };

  it("previews only the tail while the turn runs", () => {
    const result = collapse({ ...base, text: long(20), running: true });

    expect(result.hidden).toBe(true);
    expect(result.shown.startsWith("…")).toBe(true);
    expect(result.shown.split("\n")).toHaveLength(PREVIEW_LINES + 1);
  });

  it("hides a long settled entry entirely", () => {
    const result = collapse({ ...base, text: long(20), running: false });

    expect(result.shown).toBe("");
    expect(result.hidden).toBe(true);
    expect(result.summary).toBe("20 líneas");
  });

  it("shows everything when expanded", () => {
    const result = collapse({ ...base, text: long(20), running: false, expanded: true });

    expect(result.hidden).toBe(false);
    expect(result.shown.split("\n")).toHaveLength(20);
  });

  it("never hides a failed tool", () => {
    const result = collapse({
      ...base,
      role: "tool",
      text: long(30),
      running: false,
      failed: true,
    });

    expect(result.hidden).toBe(false);
    expect(result.shown.split("\n")).toHaveLength(30);
  });

  it("shows a short entry even when settled", () => {
    const result = collapse({ ...base, text: "short", running: false });

    expect(result.shown).toBe("short");
    expect(result.hidden).toBe(false);
  });

  it("summarises single-line entries by characters", () => {
    const result = collapse({ ...base, text: "a".repeat(120), running: false });

    expect(result.summary).toBe("120 car.");
  });
});
