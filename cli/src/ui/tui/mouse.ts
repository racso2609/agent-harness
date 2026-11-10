// SGR mouse vocabulary for the TUI.
//
// `viewport.ts` turns a wheel notch into scroll lines; this module is the layer
// under it, the one that knows what a mouse report *is*. The split is on
// purpose: the transcript only ever cared about the wheel, but a click is about
// to mean "cancel the running turn", and a second regex reading the same escape
// sequences would drift from the first. There is one lexer of SGR reports in the
// package and it lives here.
//
// Pure on purpose — no ink, no React, no stdin — so every row of the SGR table
// can be asserted in vitest without mounting anything.
//
// Two things the caller has to know:
//
// The one report that means a cancellation, once the TUI acts on clicks, is
// `{ phase: "press", button: "left" }`. Everything else is hover, wheel, or
// noise and is ignored. Nothing here decides that; this module only names the
// report, and the rule is written down so the decision is made once.
//
// With `?1003h` every tiny movement of the mouse arrives as its own chunk on
// stdin. Whoever taps the stream must stay O(chunk) and keep no state between
// calls: an accumulator here would grow with the mouse and leak across turns.

export type MouseButton = "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "other";

// `move` covers both a drag (a button held down) and bare motion (`?1003h`).
export type MousePhase = "press" | "release" | "move";

export interface MouseReport {
button: MouseButton;
phase: MousePhase;
// 1-based, as the terminal sent them: no conversion to screen indices here.
col: number;
row: number;
}

// `ESC [ < button ; column ; row M` (press) or `m` (release). The coordinates
// are captured now, not only the button: a click has to say *where*.
// eslint-disable-next-line no-control-regex -- SGR mouse reports start with ESC.
const SGR_MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;

// SGR button codes carry modifiers in the low bits, so a shift-click is not
// code 0. Only the ranges the table below lists are translated; anything else
// is `other` and the caller can decide to ignore it.
const BUTTONS: Record<number, MouseButton> = {
0: "left",
1: "middle",
2: "right",
64: "wheel-up",
65: "wheel-down",
};

// Drag codes are the button code plus 32: 32/33/34 drag the left/middle/right
// button and 35 is motion with no button, which is what `?1003h` reports.
const DRAG_OFFSET = 32;

const buttonOf = (code: number): MouseButton => BUTTONS[code] ?? "other";

const toReport = (rawButton: number, terminator: string, col: number, row: number): MouseReport => {
const isRelease = terminator === "m";

// Motion: 32/33/34 drag a held button, 35 is bare motion (`?1003h`) or a held
// right/other button. `m` with 35 is the terminal saying the movement stopped.
if (rawButton === DRAG_OFFSET + 3) return { button: "other", phase: "move", col, row };
if (rawButton >= DRAG_OFFSET && rawButton < DRAG_OFFSET + 3) {
return { button: buttonOf(rawButton - DRAG_OFFSET), phase: "move", col, row };
}

// 3 is "released with no button", which terminals send instead of the button
// code; anything else released names the button that let go.
if (isRelease) return { button: buttonOf(rawButton), phase: "release", col, row };

// The wheel and the buttons only ever press: terminals send no release for the
// wheel, and a click that is cancelled is cancelled on the press.
return { button: buttonOf(rawButton), phase: "press", col, row };
};

// Every report carried by one raw stdin chunk, in order. A chunk can mix a
// trackpad burst, keystrokes and a click, so this scans the whole string
// instead of assuming a single report.
export const parseMouseReports = (input: string): MouseReport[] => {
const reports: MouseReport[] = [];

for (const match of input.matchAll(SGR_MOUSE)) {
// An unmapped code, >= 128 included, is still a report: it lands as `other`
// rather than disappearing, so a future click handler can tell "no mouse" from
// "a button I do not know".
reports.push(toReport(Number(match[1]), match[4], Number(match[2]), Number(match[3])));
}

return reports;
};
