// Pane geometry and key mapping. These two answers decide how far one keypress
// moves and how many rows the transcript owns, so they are asserted as plain
// numbers: no ink, no TTY, and a failure points straight at the arithmetic that
// made the transcript jump.

import { describe, expect, it } from "vitest";
import { bottomView, scrollBy } from "../../src/ui/tui/scroll";
import {
  APPROVAL_ROWS,
  INPUT_ROWS,
  MIN_VIEWPORT,
  STATUS_ROWS,
  STRIP_BORDER_ROWS,
  TRANSCRIPT_CHROME_Y,
  chromeRows,
  nextView,
  scrollActionForKey,
  viewportRows,
} from "../../src/ui/tui/viewport";

// A keystroke as ink reports it: flags plus the printable input.
const key = (overrides: Record<string, boolean> = {}) => ({
  ctrl: false,
  meta: false,
  ...overrides,
});
const none = key();

describe("chromeRows", () => {
  it("charges only the transcript border, the input box and the status bar when nothing else is up", () => {
    const chrome = chromeRows({ stripRows: 0, approval: false });

    expect(chrome).toEqual({
      inner: TRANSCRIPT_CHROME_Y,
      middle: INPUT_ROWS,
      status: STATUS_ROWS,
    });
  });

  it("adds the spawn strip, its border and the older-runs counter when children are on screen", () => {
    const chrome = chromeRows({ stripRows: 3, approval: false });

    // Children plus the counter both live inside one bordered strip.
    expect(chrome.middle).toBe(INPUT_ROWS + 3 + STRIP_BORDER_ROWS);
  });

  it("swaps the input box for the taller approval box instead of stacking them", () => {
    const chrome = chromeRows({ stripRows: 0, approval: true });

    expect(chrome.middle).toBe(APPROVAL_ROWS);
  });
});

describe("viewportRows", () => {
  it("is the terminal minus everything stacked around the transcript", () => {
    const chrome = chromeRows({ stripRows: 0, approval: false });

    expect(viewportRows(30, chrome)).toBe(30 - (TRANSCRIPT_CHROME_Y + INPUT_ROWS + STATUS_ROWS));
  });

  it("never drops below the floor, so a tiny terminal still shows a scrolled transcript", () => {
    expect(viewportRows(4, chromeRows({ stripRows: 0, approval: true }))).toBe(MIN_VIEWPORT);
    expect(viewportRows(0, chromeRows({ stripRows: 0, approval: false }))).toBe(MIN_VIEWPORT);
  });

  it("survives a terminal that reports no size at all", () => {
    expect(viewportRows(Number.NaN, chromeRows({ stripRows: 0, approval: false }))).toBe(
      MIN_VIEWPORT,
    );
  });
});

describe("scrollActionForKey", () => {
  // Page sizes are derived from the viewport, so the test states the rule rather
  // than a magic number: one page keeps a line of context.
  it("pages up and down by a screen, keeping one line of overlap", () => {
    expect(scrollActionForKey(key({ pageUp: true }), "", 20, false)).toEqual({
      kind: "by",
      lines: 19,
    });
    expect(scrollActionForKey(key({ pageDown: true }), "", 20, false)).toEqual({
      kind: "by",
      lines: -19,
    });
  });

  it("half-pages with ctrl+u and ctrl+d", () => {
    expect(scrollActionForKey(key({ ctrl: true }), "u", 20, false)).toEqual({
      kind: "by",
      lines: 10,
    });
    expect(scrollActionForKey(key({ ctrl: true }), "d", 20, false)).toEqual({
      kind: "by",
      lines: -10,
    });
  });

  it("moves a single line with the arrows, which the draft used to swallow", () => {
    expect(scrollActionForKey(key({ upArrow: true }), "", 20, false)).toEqual({
      kind: "by",
      lines: 1,
    });
    expect(scrollActionForKey(key({ downArrow: true }), "", 20, false)).toEqual({
      kind: "by",
      lines: -1,
    });
  });

  it("leaves the arrows to the approval box while a question waits", () => {
    // Arrow keys pick an option there: a scroll that also ate the key would make
    // the question unanswerable.
    expect(scrollActionForKey(key({ upArrow: true }), "", 20, true)).toBeNull();
    expect(scrollActionForKey(key({ downArrow: true }), "", 20, true)).toBeNull();
    // Paging is still ours: the transcript stays readable behind the question.
    expect(scrollActionForKey(key({ pageUp: true }), "", 20, true)).toEqual({
      kind: "by",
      lines: 19,
    });
  });

  it("jumps to the ends with home and end", () => {
    expect(scrollActionForKey(key({ home: true }), "", 20, false)).toEqual({ kind: "top" });
    expect(scrollActionForKey(key({ end: true }), "", 20, false)).toEqual({ kind: "bottom" });
  });

  it("returns null for anything else, so typing is never eaten", () => {
    expect(scrollActionForKey(none, "h", 20, false)).toBeNull();
    expect(scrollActionForKey(none, "", 20, false)).toBeNull();
  });
});

describe("nextView", () => {
  const total = 100;
  const viewport = 20;

  it("returns null for a non-scroll key instead of moving the view", () => {
    expect(nextView(none, "a", bottomView(), total, viewport, false)).toBeNull();
  });

  it("moves exactly one line per arrow and stops following the stream", () => {
    const view = nextView(key({ upArrow: true }), "", bottomView(), total, viewport, false);

    expect(view).toEqual({ offset: 1, follow: false });
  });

  it("clamps at the top instead of running past the oldest line", () => {
    const view = nextView(key({ pageUp: true }), "", bottomView(), total, viewport, false);

    // One page from the bottom: 19 lines up, nowhere near the top yet.
    expect(view).toEqual({ offset: 19, follow: false });
  });

  it("re-arms following when the bottom is reached again", () => {
    const scrolled = scrollBy(bottomView(), 5);
    const view = nextView(key({ end: true }), "", scrolled, total, viewport, false);

    expect(view).toEqual({ offset: 0, follow: true });
  });

  it("walks down one line at a time and lands following at the bottom", () => {
    let view = scrollBy(bottomView(), 3);

    for (let step = 0; step < 3; step++) {
      view = nextView(key({ downArrow: true }), "", view, total, viewport, false)!;
    }

    expect(view).toEqual({ offset: 0, follow: true });
  });

  it("pulls a stale offset back into a transcript that got shorter", () => {
    const scrolled = scrollBy(bottomView(), 60);
    const view = nextView(key({ pageDown: true }), "", scrolled, 30, viewport, false);

    // A stale `offset: 60` labels content that no longer exists. 30 lines in a
    // 20-line pane leaves 10 lines of scroll, which is where the view lands.
    expect(view).toEqual({ offset: 10, follow: false });
  });
});
