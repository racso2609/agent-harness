// Every case here asserts on the numbers the pane would paint (heights, offsets,
// paddings), which is exactly where the "show the last N entries" bug lived. No
// ink, no TTY.

import { describe, expect, it } from "vitest";
import { PREVIEW_LINES } from "../../src/ui/tui/collapse";
import { GAP } from "../../src/ui/tui/layout";
import {
  bottomView,
  clampView,
  measureEntries,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  viewWithContent,
  visibleWindow,
  type ScrollView,
} from "../../src/ui/tui/scroll";

// A transcript entry as the module sees it: a role plus its plain text.
interface Entry {
  role: "answer" | "reasoning" | "tool" | "notice";
  text: string;
}

const context = (
  overrides: Partial<{ width: number; running: boolean; expanded: Set<number> }>,
) => ({
  width: Infinity,
  running: false,
  expanded: new Set<number>(),
  textOf: (line: Entry) => line.text,
  ...overrides,
});

const answers = (count: number): Entry[] =>
  Array.from({ length: count }, (_, index) => ({ role: "answer" as const, text: `L${index}` }));

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

// `rowOf(n)`: heights of n single-line entries, all alike.
const rowOf = (n: number) => Array.from({ length: n }, () => 1);

describe("measureEntries", () => {
  it("gives the first entry of the transcript no gap and later entries one", () => {
    const { heights, total } = measureEntries(answers(3), context({}));

    expect(heights[0]).toBe(1);
    expect(heights[1]).toBe(1 + GAP);
    expect(heights[2]).toBe(1 + GAP);
    expect(total).toBe(1 + 2 * (1 + GAP));
  });

  it("wraps an entry that is longer than the width", () => {
    // 10 characters at width 4 is three visual rows.
    const entry: Entry[] = [{ role: "answer", text: "0123456789" }];

    expect(measureEntries(entry, context({ width: 4 })).total).toBe(3);
  });

  it("measures a running tool entry as its preview, not as the whole output", () => {
    const entry: Entry[] = [{ role: "tool", text: lines(40) }];
    const running = measureEntries(entry, context({ running: true })).heights[0]!;
    const settled = measureEntries(entry, context({ running: false })).heights[0]!;

    // Header + the "…" marker + PREVIEW_LINES of tail.
    expect(running).toBe(1 + 1 + PREVIEW_LINES);
    // A settled tool of this length collapses to its header only.
    expect(settled).toBe(1);
  });

  it("measures an expanded entry in full", () => {
    const entry: Entry[] = [{ role: "reasoning", text: lines(40) }];
    const collapsed = measureEntries(entry, context({})).heights[0]!;
    const expanded = measureEntries(entry, context({ expanded: new Set([0]) })).heights[0]!;

    expect(collapsed).toBe(1);
    // Expanded shows the header plus every line, so the height follows the content.
    expect(expanded).toBe(1 + 40);
  });

  it("only collapses the roles that collapse", () => {
    // A long answer and a long notice are never hidden, even mid-turn.
    const entry: Entry[] = [
      { role: "answer", text: lines(40) },
      { role: "notice", text: lines(3) },
    ];
    const { heights } = measureEntries(entry, context({ running: true }));

    expect(heights).toEqual([40, 3 + GAP]);
  });
});

describe("scrollBy / clampView", () => {
  it("pins the view to the bottom when there is nothing to scroll", () => {
    const view = clampView(scrollBy(bottomView(), 5), 3, 10);

    // Content shorter than the viewport: the offset cannot go anywhere and
    // follow comes back on its own, because there is only one position.
    expect(view).toEqual({ offset: 0, follow: true });
  });

  it("stops following new content as soon as the user scrolls up", () => {
    const view = clampView(scrollBy(bottomView(), 3), 100, 10);

    expect(view.offset).toBe(3);
    expect(view.follow).toBe(false);
  });

  it("re-arms follow when the user reaches the bottom again", () => {
    const scrolled = clampView(scrollBy(bottomView(), 20), 100, 10);
    const back = clampView(scrollBy(scrolled, -7), 100, 10);

    expect(back.offset).toBe(13);
    expect(back.follow).toBe(false);

    // 13 more lines down lands exactly at the bottom.
    const bottom = clampView(scrollBy(back, -13), 100, 10);

    expect(bottom.offset).toBe(0);
    expect(bottom.follow).toBe(true);
  });

  it("never lets the offset leave the transcript", () => {
    // Without the clamp these would be 500 and -80, and the pane would show
    // nothing at all.
    expect(clampView(scrollBy(bottomView(), 500), 100, 10).offset).toBe(90);
    expect(clampView(scrollBy(bottomView(), -80), 100, 10).offset).toBe(0);
  });

  it("jumps to the top and to the bottom", () => {
    const top = clampView(scrollToTop(), 100, 10);
    const bottom = clampView(scrollToBottom(), 100, 10);

    expect(top).toEqual({ offset: 90, follow: false });
    expect(bottom).toEqual({ offset: 0, follow: true });
  });

  it("does not mutate the view it is given", () => {
    const frozen = Object.freeze({ offset: 5, follow: false }) satisfies ScrollView;
    const next = clampView(scrollBy(frozen, 10), 100, 10);

    expect(frozen).toEqual({ offset: 5, follow: false });
    expect(next).not.toBe(frozen);
  });
});

describe("viewWithContent", () => {
  it("keeps a scrolled-up view on the same lines while the content grows", () => {
    const first = clampView(scrollBy(bottomView(), 12), 100, 10);
    const grown = viewWithContent(first, 140, 10);

    expect(grown).toEqual({ offset: 12, follow: false });

    // Anchored 12 lines above the bottom, so the top of the pane moves down by
    // exactly the 40 lines that were appended and keeps its alignment.
    const before = visibleWindow({ heights: rowOf(100), viewportLines: 10, view: first });
    const after = visibleWindow({ heights: rowOf(140), viewportLines: 10, view: grown });

    expect(before.start).toBe(78);
    expect(after.start).toBe(118);
    expect(before.rows[0]!.cutTop).toBe(after.rows[0]!.cutTop);
  });

  it("keeps a following view at the bottom while the content grows", () => {
    const grown = viewWithContent(bottomView(), 140, 10);
    const window = visibleWindow({ heights: rowOf(140), viewportLines: 10, view: grown });

    expect(grown).toEqual({ offset: 0, follow: true });
    expect(window.start).toBe(130);
    expect(window.end).toBe(140);
  });

  it("re-clamps the offset when the head is trimmed", () => {
    // The user was 50 lines up; only 20 lines are left, so 10 is as far back as
    // the view can go and it must not point past the top.
    const scrolled: ScrollView = { offset: 50, follow: false };

    expect(viewWithContent(scrolled, 20, 10).offset).toBe(10);
    // Growing content, by contrast, keeps the offset untouched.
    expect(viewWithContent(scrolled, 120, 10).offset).toBe(50);
  });

  it("keeps the anchor across a resize to fewer rows", () => {
    const scrolled = clampView(scrollBy(bottomView(), 20), 100, 10);
    // Same content, a much shorter pane: 100 lines still leave 60 to scroll, so
    // the offset survives untouched and the same line stays at the top.
    const resized = viewWithContent(scrolled, 100, 40);
    const window = visibleWindow({ heights: rowOf(100), viewportLines: 40, view: resized });

    expect(resized).toEqual({ offset: 20, follow: false });
    expect(window.start).toBe(40);
  });

  it("clamps the anchor when a resize makes the offset unreachable", () => {
    const scrolled = clampView(scrollBy(bottomView(), 90), 100, 10);
    const resized = viewWithContent(scrolled, 100, 95);

    expect(resized.offset).toBe(5);
    expect(resized.follow).toBe(false);
  });
});

describe("visibleWindow", () => {
  it("fills the viewport exactly with the last entries when following", () => {
    const window = visibleWindow({ heights: rowOf(6), viewportLines: 3, view: bottomView() });

    expect(window.start).toBe(3);
    expect(window.end).toBe(6);
    expect(window.rows.map((row) => row.absolute)).toEqual([3, 4, 5]);
    expect(window.rows.every((row) => row.cutTop === 0 && row.cutBottom === 0)).toBe(true);
    expect(window.padTop).toBe(0);
    expect(window.padBottom).toBe(0);
  });

  it("cuts the top entry when it only fits halfway", () => {
    // Entries of 4 lines, pane of 4, offset 5: total 12, so top = 12 - 5 - 4 = 3.
    const view: ScrollView = { offset: 5, follow: false };
    const window = visibleWindow({ heights: [4, 4, 4], viewportLines: 4, view });

    expect(window.start).toBe(0);
    expect(window.end).toBe(2);
    expect(window.rows).toEqual([
      { absolute: 0, cutTop: 3, cutBottom: 0 },
      { absolute: 1, cutTop: 0, cutBottom: 1 },
    ]);
  });

  it("pads the top instead of shrinking the pane when the content is short", () => {
    const window = visibleWindow({ heights: rowOf(2), viewportLines: 5, view: bottomView() });

    expect(window.rows.map((row) => row.absolute)).toEqual([0, 1]);
    expect(window.padTop).toBe(3);
    // Painted lines plus padding are the whole viewport: ink has nothing to
    // clip, and the text sits at the bottom like a prompt.
    expect(window.padTop + window.padBottom + 2).toBe(5);
  });

  it("never asks for negative padding nor cuts more than an entry has", () => {
    // An offset past the top is clamped to the real limit first, so the pane
    // still shows the newest lines instead of blank.
    const window = visibleWindow({ heights: [30], viewportLines: 10, view: { offset: 999 } });

    expect(window.padTop).toBe(0);
    expect(window.padBottom).toBe(0);
    expect(window.rows).toEqual([{ absolute: 0, cutTop: 0, cutBottom: 20 }]);
    expect(30 - window.rows[0]!.cutTop - window.rows[0]!.cutBottom).toBe(10);
  });

  it("returns a full padding window for an empty transcript", () => {
    const window = visibleWindow({ heights: [], viewportLines: 4, view: bottomView() });

    expect(window.rows).toEqual([]);
    expect(window.start).toBe(0);
    expect(window.end).toBe(0);
    expect(window.padTop).toBe(4);
    expect(window.padBottom).toBe(0);
  });

  it("accounts for measured heights, not entry count", () => {
    // A settled tool collapses to its header (1 row, and no gap because it is
    // first); each answer is one row plus its gap.
    const measured = measureEntries(
      [
        { role: "tool" as const, text: lines(40) },
        { role: "answer" as const, text: "a" },
        { role: "answer" as const, text: "b" },
      ],
      context({}),
    );
    const window = visibleWindow({
      heights: measured.heights,
      viewportLines: 4,
      view: bottomView(),
    });

    expect(measured.heights).toEqual([1, 1 + GAP, 1 + GAP]);
    // Three entries, but only two fit in four lines: counting entries instead of
    // lines would have painted one too many and overflowed the pane.
    expect(window.rows.map((row) => row.absolute)).toEqual([1, 2]);
    expect(window.padTop).toBe(0);
  });
});
