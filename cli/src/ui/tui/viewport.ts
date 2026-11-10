// Pane geometry and scroll key mapping for the TUI transcript.
//
// `scroll.ts` knows how to move through measured lines, but it does not know
// how many lines the terminal leaves for the transcript, nor which keystroke
// means what. Both answers are pure arithmetic, so they live here instead of
// inside App.tsx, where they could only be checked by mounting ink on a real
// TTY.

import { parseMouseReports } from "./mouse";
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

// Rows the "/" dropdown shows at most before it scrolls with a "3/15" hint.
// Small on purpose: the transcript is the screen, the dropdown is a guest.
export const MENU_VISIBLE_ROWS = 4;
// The whole dropdown panel: its round border, the visible rows and the help
// line that carries the range indicator.
export const MENU_CHROME_Y = MENU_VISIBLE_ROWS + 3;
// The part of that height that never changes: both borders and the help line.
// A dropdown showing fewer rows paints exactly these plus what it shows, so
// the transcript is charged for the panel that exists and not for the biggest.
export const MENU_PANEL_CHROME_Y = BORDER_ROWS + 1;

// The picker of a flow: round border, the question above the options and the
// hint below them. The options themselves are charged as they are painted.
// Round border, both padding rows, the question and the hint; the options add
// one row each, which is why the caller charges the rows it really paints.
export const SELECT_CHROME_Y = BORDER_ROWS + PANEL_PADDING_Y * 2 + 2;

// The question panel of a flow: round border, both padding rows and the three
// rows it always paints (message, answer, help). It is a fixed height like the
// approval box, because its layout does not depend on what is asked.
export const PROMPT_CHROME_Y = BORDER_ROWS + PANEL_PADDING_Y * 2 + 3;

// Splits the terminal into the rows the transcript gets and the rows its
// neighbours take, given what is on screen right now.
export const chromeRows = ({
  stripRows,
  approval,
  menuRows = 0,
  selectionRows = 0,
  promptRows = 0,
}: {
  // Rows of the spawn strip, the "older" counter included; 0 when hidden.
  stripRows: number;
  approval: boolean;
  // Rows the dropdown under the input box really paints. Only the menu needs
  // this: the other panels have a fixed height, while a list of four commands
  // must not charge the transcript for a fifth row it never draws.
  menuRows?: number;
  // Rows the picker panel really paints, borders included; 0 when it is shut.
  selectionRows?: number;
  // Rows the question panel really paints, borders included; 0 when there is
  // none.
  promptRows?: number;
}): ChromeRows => ({
  inner: TRANSCRIPT_CHROME_Y,
  middle:
    (stripRows > 0 ? stripRows + STRIP_BORDER_ROWS : 0) +
    // An approval, a picker and the input box are charged for what is painted:
    // the box only when nothing else can take typing, since the panels above it
    // replace it. An approval and a picker can both be up (the approval keeps
    // the keys), so they are summed instead of swapped. A question replaces the
    // box the same way a picker does.
    (approval ? APPROVAL_ROWS : 0) +
    (selectionRows > 0 ? selectionRows : promptRows > 0 ? promptRows : approval ? 0 : INPUT_ROWS) +
    menuRows,
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

// Any-event tracking: every movement of the pointer is reported, which is what
// a hover needs. It is a separate pair of sequences on purpose — `MOUSE_ENABLE`
// above is what a terminal without motion support still understands, so the
// hover rides on top of it instead of replacing it.
//
// A terminal that ignores `?1003` (Apple Terminal, tmux without
// `set -g mouse on`) simply never sends motion. The wheel and the click keep
// working and the highlight never appears: there is no error to report and
// nothing to fall back to.
export const MOUSE_HOVER_ENABLE = "\u001b[?1003h";
export const MOUSE_HOVER_DISABLE = "\u001b[?1003l";

// Scroll deltas, in lines, carried by one raw stdin chunk. Positive scrolls up,
// matching `scrollBy`. A chunk can hold several notches when the terminal
// batches them, so the caller applies them in order.
//
// The SGR lexer lives in `mouse.ts`, not here: the wheel is one reading of a
// mouse report and the click that will cancel a turn is another, and two regexes
// over the same escape sequences drift. `WHEEL_LINES` stays in this module and
// is not imported by the parser, so the dependency only ever goes
// viewport -> mouse and there is no import cycle to untangle.
export const wheelScrollLines = (input: string): number[] => {
  const deltas: number[] = [];

  for (const report of parseMouseReports(input)) {
    if (report.button === "wheel-up") deltas.push(WHEEL_LINES);
    else if (report.button === "wheel-down") deltas.push(-WHEEL_LINES);
  }

  return deltas;
};
