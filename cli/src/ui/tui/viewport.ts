// Pane geometry and scroll key mapping for the TUI transcript.
//
// `scroll.ts` knows how to move through measured lines, but it does not know
// how many lines the terminal leaves for the transcript, nor which keystroke
// means what. Both answers are pure arithmetic, so they live here instead of
// inside App.tsx, where they could only be checked by mounting ink on a real
// TTY.

import { clampView, scrollBy, scrollToBottom, scrollToTop, type ScrollView } from "./scroll";

// Rows the transcript pane spends on things that are not transcript lines.
// `inner` counts the rows inside the border (one top, one bottom); the other
// rows belong to the panels stacked under it.
export interface ChromeRows {
  // Rows of the transcript box: both borders plus everything painted inside.
  inner: number;
  // Spawn strip, approval/question box or input box.
  middle: number;
  // Status bar.
  status: number;
}

// Border of a box drawn with `borderStyle` takes one row on each side.
export const BORDER_ROWS = 2;

// Rows the pane keeps even when the terminal is too small to honour the
// request. Below this the layout stops shrinking and lets the terminal scroll.
export const MIN_VIEWPORT = 3;

// Height of the transcript pane, in rows of visual lines.
export const viewportRows = (rows: number, chrome: ChromeRows): number => {
  const safeRows = Number.isFinite(rows) ? Math.floor(rows) : 0;
  const used = chrome.inner + chrome.middle + chrome.status;

  // A terminal shorter than the chrome still has to leave *some* room for the
  // conversation: dropping to zero rows would paint a transcript box with no
  // content, which reads as "the scroll does nothing".
  return Math.max(MIN_VIEWPORT, safeRows - used);
};

// Rows of each panel stacked under the transcript. They are layout constants,
// not render details: the viewport height is what the scroll maths needs, so the
// arithmetic lives next to it where it can be tested.
export const STATUS_ROWS = 1;
// Round border plus the single prompt line.
export const INPUT_ROWS = 3;
// Round border, title, subject, a blank row, the three choices and the hint.
export const APPROVAL_ROWS = 9;
// Single border of the spawn strip; its children add one row each.
export const STRIP_BORDER_ROWS = 2;

// Splits the terminal into the rows the transcript gets and the rows its
// neighbours take, given what is on screen right now.
export const chromeRows = ({
  stripRows,
  approval,
}: {
  // Rows of the spawn strip, the "older" counter included; 0 when hidden.
  stripRows: number;
  approval: boolean;
}): ChromeRows => ({
  inner: BORDER_ROWS,
  middle:
    (stripRows > 0 ? stripRows + STRIP_BORDER_ROWS : 0) +
    // The approval box and the input box never share the screen.
    (approval ? APPROVAL_ROWS : INPUT_ROWS),
  status: STATUS_ROWS,
});

// What a keystroke asks the transcript to do. `null` means "not a scroll key":
// the caller must let the key through, otherwise a single arrow would both
// scroll and disappear from the draft.
export type ScrollAction = { kind: "by"; lines: number } | { kind: "top" } | { kind: "bottom" };

// The subset of ink's `Key` the mapping reads.
export interface ScrollKey {
  pageUp?: boolean;
  pageDown?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

// One page scrolls slightly less than the pane, so the reader keeps one line of
// context instead of landing on a completely fresh screen.
const pageLines = (viewport: number): number => Math.max(1, viewport - 1);

const halfPage = (viewport: number): number => Math.max(1, Math.floor(viewport / 2));

// Translates a keystroke into a scroll action.
//
// The arrows are the tricky ones: they are also how the approval box chooses an
// option, so `approval` short-circuits them here and lets the caller's own
// handler decide. Otherwise they mean one line each, which is what the input
// box fallback used to swallow.
export const scrollActionForKey = (
  key: ScrollKey,
  input: string,
  viewport: number,
  approval: boolean,
): ScrollAction | null => {
  if (key.pageUp) return { kind: "by", lines: pageLines(viewport) };
  if (key.pageDown) return { kind: "by", lines: -pageLines(viewport) };

  if (key.ctrl && input === "u") return { kind: "by", lines: halfPage(viewport) };
  if (key.ctrl && input === "d") return { kind: "by", lines: -halfPage(viewport) };

  // The approval box talks with the arrows, so they are not ours there.
  if (!approval) {
    if (key.upArrow) return { kind: "by", lines: 1 };
    if (key.downArrow) return { kind: "by", lines: -1 };
  }

  if (key.home) return { kind: "top" };
  if (key.end) return { kind: "bottom" };

  return null;
};

// Applies one keystroke to the scroll position and clamps the result.
//
// This is the "one key, one move" contract in one place: translate, apply,
// clamp. The clamp is what makes the pane stable while a turn streams: the
// same offset means the same lines stay put, and the bottom re-arms `follow`.
// Returns `null` for a key that is not a scroll key, so the caller can fall
// through to its own handling instead of eating the input.
export const nextView = (
  key: ScrollKey,
  input: string,
  view: ScrollView,
  contentLines: number,
  viewportLines: number,
  approval = false,
): ScrollView | null => {
  const action = scrollActionForKey(key, input, viewportLines, approval);
  if (!action) return null;

  const moved =
    action.kind === "by"
      ? scrollBy(view, action.lines)
      : action.kind === "top"
        ? scrollToTop()
        : scrollToBottom();

  return clampView(moved, contentLines, viewportLines);
};
