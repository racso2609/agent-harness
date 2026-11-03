// Scroll model for the TUI transcript.
//
// The transcript used to paint "the last N entries", which is not a viewport:
// entries have wildly different heights (a collapsed tool preview vs a code
// block), so a fixed count either leaves the pane half empty or pushes the
// answer off screen. This module measures the transcript in *visual lines* and
// keeps a scroll position over it, so the pane can always be filled exactly and
// the user can look back without the next streamed delta yanking the view.
//
// Everything here is pure and free of ink/React: the arrow keys live in App.tsx
// and only call these functions.

import { collapse, type CollapsibleRole, estimateLines } from "./collapse";
import { GAP, gapBefore } from "./layout";

// Scroll position of the transcript. `offset` counts visual lines the user has
// scrolled up from the bottom (0 = pinned to the bottom), so it survives content
// growing below: the same number always means "same line on screen" as long as
// nothing is trimmed above it. `follow` is the intent ("stay at the bottom"),
// which is different from `offset === 0`: a pane whose content fits the viewport
// sits at offset 0 without the user having asked to follow anything.
export interface ScrollView {
  offset: number;
  follow: boolean;
}

// The initial view: pinned to the bottom, so the answer stays in sight.
export const bottomView = (): ScrollView => ({ offset: 0, follow: true });

// What the measurement needs to know about one entry. Kept structural (no import
// from App.tsx) so the transcript type can be mapped onto it.
export interface MeasuredLine {
  role: string;
}

export interface HeightContext<T> {
  // Terminal columns already discounted by the pane border and padding.
  width: number;
  // A turn is in flight: reasoning and tool entries preview their tail.
  running: boolean;
  // Absolute transcript indexes the user opened explicitly.
  expanded: Set<number>;
  // Text of one entry, flattened to plain text. The caller owns the rendering; the
  // helper only needs the characters to wrap them.
  textOf: (line: T) => string;
  // Output of a tool that failed is never hidden, even settled.
  failedOf?: (line: T) => boolean;
}

const COLLAPSIBLE: Set<string> = new Set<CollapsibleRole>(["reasoning", "tool"]);

// Header line a collapsed entry always keeps: it carries the summary and the
// expand hint, so it is printed whether or not the body is hidden.
const HEADER_LINES = 1;

// Visual height of a block of text at a given width.
export const heightOfText = (text: string, width: number): number =>
  estimateLines(text, width).length;

// Height in visual lines of one entry, gap above it included.
export const heightOf = <T extends MeasuredLine>(
  line: T,
  absolute: number,
  context: HeightContext<T>,
): number => {
  const gap = gapBefore(absolute);
  const text = context.textOf(line);

  if (!COLLAPSIBLE.has(line.role)) {
    // Roles painted in full: only wrapping adds lines. An empty entry still needs
    // one row, otherwise it would be invisible and could not be scrolled to.
    return gap + Math.max(1, heightOfText(text, context.width));
  }

  const view = collapse({
    role: line.role as CollapsibleRole,
    text,
    width: context.width,
    running: context.running,
    expanded: context.expanded.has(absolute),
    failed: context.failedOf?.(line),
  });

  if (!view.shown) return gap + HEADER_LINES;

  return gap + HEADER_LINES + heightOfText(view.shown, context.width);
};

export interface MeasuredEntries {
  // Height of each entry in input order, gap already included.
  heights: number[];
  // Sum of `heights`: what the transcript occupies from its first line to its last.
  total: number;
}

// Measures the whole transcript. The gap lives inside each entry's height on
// purpose: that way "how much is above this entry" is a plain prefix sum, with
// no separate accounting for spacing, and `gapBefore` keeps the first entry of
// the transcript flush while scrolled-to entries keep their air.
export const measureEntries = <T extends MeasuredLine>(
  lines: T[],
  context: HeightContext<T>,
): MeasuredEntries => {
  const heights = lines.map((line, absolute) => heightOf(line, absolute, context));

  return { heights, total: heights.reduce((sum, height) => sum + height, 0) };
};

// How far back the first line of the transcript is; zero when the content fits,
// so no scroll is possible at all.
const maxOffset = (contentLines: number, viewportLines: number): number =>
  Math.max(0, contentLines - viewportLines);

// Keeps the offset inside the transcript and re-arms `follow` once it reaches
// the bottom. Called on every content change and on resize, so no other place
// has to remember to clamp.
export const clampView = (
  view: ScrollView,
  contentLines: number,
  viewportLines: number,
): ScrollView => {
  const limit = maxOffset(contentLines, viewportLines);
  const offset = Math.min(Math.max(0, Math.round(view.offset)), limit);

  // Scrolling all the way down by hand *is* asking to follow: the next delta must
  // keep the bottom pinned instead of pushing the view up.
  return { offset, follow: offset === 0 };
};

// Positive `lines` scrolls up (towards older content), negative scrolls down;
// the caller decides which key means which. The clamp happens later, in
// `viewWithContent`, so an overscroll never sticks.
export const scrollBy = (view: ScrollView, lines: number): ScrollView => ({
  offset: view.offset + lines,
  // Any manual move releases the follow: the user is choosing where to look.
  follow: false,
});

// The exact top is only known once the content size is known, so this asks for
// "as far up as possible" and lets the clamp resolve it.
export const scrollToTop = (): ScrollView => ({ offset: Number.MAX_SAFE_INTEGER, follow: false });

export const scrollToBottom = (): ScrollView => ({ offset: 0, follow: true });

// Re-clamps a view after the content changed.
//
// - Growing content: a scrolled-up view keeps its offset, so the same lines stay
//   on screen while a delta arrives below (following, by contrast, drags the
//   user to the bottom). A following view stays at offset 0, which already means
//   "the bottom", so no arithmetic is needed.
// - Trimming from the head (`trimAnchored` drops entries at the front): the old
//   offset points at content that no longer exists. It is re-clamped against the
//   new size, i.e. the view slides with the content and is never left showing
//   past the top. Keeping a stale offset would silently turn a "scrolled up"
//   view into the very head of a shorter transcript, which is more confusing
//   than the small jump; the cost is that a user reading at the top loses the
//   `dropped` lines that were cut. That is acceptable because the head is only
//   trimmed far behind the viewport (MAX_LINES is much larger than the pane).
export const viewWithContent = (
  view: ScrollView,
  contentLines: number,
  viewportLines: number,
): ScrollView => clampView(view, contentLines, viewportLines);

// One entry as the pane will paint it.
export interface WindowRow {
  // Index of the entry in the transcript, so the render can query `expanded`.
  absolute: number;
  // Visual lines of this entry hidden above and below the viewport.
  cutTop: number;
  cutBottom: number;
}

export interface VisibleWindow {
  // Indexes [start, end) of the entries that appear at all.
  start: number;
  end: number;
  // The same slice, entry by entry, with its cuts.
  rows: WindowRow[];
  // Blank lines the pane must draw above the first row: the transcript is shorter
  // than the viewport, so the text stays glued to the bottom as a terminal does.
  padTop: number;
  // Blank lines below the last row. Painted lines plus both paddings always add up
  // to exactly `viewportLines`, which is what keeps the pane the right size.
  padBottom: number;
}

// Resolves the visible slice. Ink clips a box that grows past its `height`, and
// it clips the bottom (the newest lines, i.e. the answer), so the pane must be
// told exactly how many rows to draw: hence the paddings.
export const visibleWindow = ({
  heights,
  viewportLines,
  view,
}: {
  heights: number[];
  viewportLines: number;
  view: ScrollView;
}): VisibleWindow => {
  const total = heights.reduce((sum, height) => sum + height, 0);
  const viewport = Math.max(0, Math.floor(viewportLines));
  const limit = maxOffset(total, viewport);
  const offset = Math.min(Math.max(0, view.offset), limit);
  // Following pins the window to the bottom; that is what makes new content push
  // the old one up instead of growing the pane.
  const top = view.follow ? total - Math.min(total, viewport) : total - offset - viewport;
  const bottom = top + viewport;

  const rows: WindowRow[] = [];

  let cursor = 0;
  let painted = 0;
  let start = heights.length;
  let end = heights.length;

  for (let index = 0; index < heights.length; index++) {
    const height = heights[index]!;
    const entryTop = cursor;
    const entryBottom = cursor + height;
    cursor = entryBottom;

    // Rows entirely above or below the viewport are skipped; a partially visible
    // one is kept and cut.
    if (entryBottom <= top) continue;
    if (entryTop >= bottom) break;

    if (start === heights.length) start = index;

    const cutTop = Math.max(0, top - entryTop);
    const cutBottom = Math.max(0, entryBottom - bottom);

    end = index + 1;
    painted += height - cutTop - cutBottom;
    rows.push({ absolute: index, cutTop, cutBottom });
  }

  // Whatever is not painted is padding, never a negative number and never a short
  // pane. Room goes above rather than below so a transcript that fits stays at the
  // bottom of the pane, like a shell prompt.
  const padTop = Math.max(0, viewport - painted);

  return { start, end, rows, padTop, padBottom: 0 };
};

// Height of the whole transcript above the viewport. Exposed so the caller can
// report the position ("12 líneas arriba") and so tests can assert on the anchor
// without re-deriving it.
export const linesAbove = (heights: number[], viewportLines: number, view: ScrollView): number => {
  const total = heights.reduce((sum, height) => sum + height, 0);
  const viewport = Math.max(0, Math.floor(viewportLines));
  const limit = maxOffset(total, viewport);
  const offset = Math.min(Math.max(0, view.offset), limit);

  return view.follow ? total - Math.min(total, viewport) : total - offset - viewport;
};

// Total height of the entries before `index`. Handy for the render to know how
// much of the first row is cut without walking the heights again.
export const heightBefore = (heights: number[], index: number): number => {
  const end = Math.min(Math.max(0, index), heights.length);

  let sum = 0;

  for (let i = 0; i < end; i++) sum += heights[i]!;

  return sum;
};

// The spacing constant is part of the contract of these heights; re-exporting
// keeps callers from importing layout only to recompute it.
export { GAP };
