import { describe, expect, it } from "vitest";
import { fitColumns, MIN_COLUMN_WIDTH, truncateCell, wrapText } from "../../src/ui/tui/layout";

describe("fitColumns", () => {
  it("keeps natural widths when everything fits", () => {
    const result = fitColumns([5, 10], 80);

    expect(result.map((c) => c.width)).toEqual([5, 10]);
    expect(result.some((c) => c.truncated)).toBe(false);
  });

  it("shrinks the widest column first", () => {
    const result = fitColumns([5, 30], 30);

    expect(result[0]!.width).toBe(5);
    expect(result[1]!.width).toBeLessThan(30);
    expect(result[1]!.truncated).toBe(true);
  });

  it("never goes below the minimum width", () => {
    const result = fitColumns([20, 20], 10);

    expect(result.every((c) => c.width >= MIN_COLUMN_WIDTH)).toBe(true);
  });

  it("returns an empty list for no columns", () => {
    expect(fitColumns([], 40)).toEqual([]);
  });
});

describe("truncateCell", () => {
  it("leaves short cells untouched", () => {
    expect(truncateCell("abc", 5)).toBe("abc");
  });

  it("cuts and marks with an ellipsis", () => {
    expect(truncateCell("abcdef", 4)).toBe("abc…");
  });

  it("degrades gracefully at width 1", () => {
    expect(truncateCell("abcdef", 1)).toBe("a");
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
  });

  it("hard-splits a word longer than the width", () => {
    expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("keeps explicit line breaks and blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("table width", () => {
  it("keeps the rendered grid within the available width", () => {
    // 4 columns with long content in a narrow terminal.
    const natural = [10, 12, 15, 8];
    const columns = fitColumns(natural, 50);
    const rendered =
      columns.reduce((sum, column) => sum + column.width + 2, 0) + columns.length + 1;

    expect(rendered).toBeLessThanOrEqual(50);
  });

  it("does not shrink columns when the table already fits", () => {
    const columns = fitColumns([4, 4], 40);

    expect(columns.every((column) => !column.truncated)).toBe(true);
  });
});
