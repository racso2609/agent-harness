// Pane geometry and scroll key mapping for the TUI transcript.
//
// `scroll.ts` knows how to move through measured lines, but it does not know
// how many lines the terminal leaves for the transcript, nor which keystroke
// means what. Both answers are pure arithmetic, so they live here instead of
// inside App.tsx, where they could only be checked by mounting ink on a real
// TTY.

import { clampView, scrollBy, scrollToBottom, scrollToTop, type ScrollView } from "./scroll";

// Rows the transcript pane spends on things that are not transcript lines.
// `inner` counts the two border rows the box adds on top of its content; the
// other rows belong to the panels stacked under it.
export interface ChromeRows {
  // Border rows of the transcript box (one top, one bottom). The content area
  // is `viewportRows`, and Ink's `height` must add these back (border box).
  inner: number;
  // Spawn strip, approval/question box or input box.
  middle: number;
  // Status bar.
  status: number;
}

// Border of a box drawn with `borderStyle` takes one row on each side.
export const BORDER_ROWS = 2;

// Breathing room inside every panel. Horizontal padding also has to be part of
// the width the transcript wraps to, and vertical padding is part of each
// panel's height, so both live here and are read by the render and the geometry
// alike. When they were written twice they drifted and the pane clipped.
export const PANEL_PADDING_X = 2;
export const PANEL_PADDING_Y = 1;

// Rows the transcript box spends on itself: both borders plus the vertical
// padding. The scroll model's `viewportRows` is the content area, so the box
// height is `viewportLines + TRANSCRIPT_CHROME_Y`.
export const TRANSCRIPT_CHROME_Y = BORDER_ROWS + PANEL_PADDING_Y * 2;

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
// Round border, vertical padding and the single prompt line.
export const INPUT_ROWS = BORDER_ROWS + PANEL_PADDING_Y * 2 + 1;
// Round border, padding, title, subject, the blank row above the choices, the
// choice row itself and the hint.
export const APPROVAL_ROWS = BORDER_ROWS + PANEL_PADDING_Y * 2 + 5;
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
  inner: TRANSCRIPT_CHROME_Y,
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

// Lines one wheel notch moves. Three is enough to feel continuous with a
// trackpad (which sends many small notches) without making a mouse wheel jump a
// whole entry per click.
export const WHEEL_LINES = 3;

// Turns SGR mouse reporting on and off. 1000 reports button presses — the wheel
// is one — and 1006 is the extended coordinate encoding terminals need past
// column 223. Ink 8 does not surface mouse events, so the TUI enables this and
// reads the wheel itself.
export const MOUSE_ENABLE = "\u001b[?1000h\u001b[?1006h";
export const MOUSE_DISABLE = "\u001b[?1006l\u001b[?1000l";

// SGR mouse reports look like `ESC [ < button ; column ; row M` (press) or `m`
// (release). Only the wheel buttons mean anything here: 64 scrolls up and 65
// down. Clicks and drags are ignored so they cannot move the transcript.
// eslint-disable-next-line no-control-regex -- SGR mouse reports start with ESC.
const SGR_MOUSE = /\u001b\[<(\d+);\d+;\d+[Mm]/g;

// Scroll deltas, in lines, carried by one raw stdin chunk. Positive scrolls up,
// matching `scrollBy`. A chunk can hold several notches when the terminal
// batches them, so the caller applies them in order.
export const wheelScrollLines = (input: string): number[] => {
  const deltas: number[] = [];

  for (const match of input.matchAll(SGR_MOUSE)) {
    const button = Number(match[1]);

    if (button === 64) deltas.push(WHEEL_LINES);
    else if (button === 65) deltas.push(-WHEEL_LINES);
  }

  return deltas;
};
