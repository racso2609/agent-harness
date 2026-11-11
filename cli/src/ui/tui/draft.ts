// Draft editing rules for the input box. Kept out of the component for the
// same reason as progress.ts: what a keystroke leaves behind is a pure
// decision, and testing it here beats a timing-fragile mount of ink.

// Ink has no "key held" event: a held backspace arrives as a stream of
// ordinary presses. It is therefore the clock that tells a burst from a
// deliberate tap. These two windows are the whole heuristic.
//
// Gap under which a press counts as part of the burst already running. A
// human typing a repeated character stays well under it; a second, separate
// tap usually takes longer.
export const BURST_GAP_MS = 600;
// How long the burst has to last before each press swallows a word. Short
// enough to feel like "keep holding it", long enough that a double tap still
// removes two characters.
export const WORD_DELETE_AFTER_MS = 400;

// What a press does to the draft.
export type BackspaceKind = "char" | "word";

// Word boundaries: whitespace and the punctuation a sentence is built from.
// The draft is a prompt, not prose: `/resume` or `foo.ts` are single things
// the user wrote on purpose and wants gone in one go, while `hola, mundo`
// splits on the comma and the space. Only common punctuation is listed — the
// point is to agree with what a prompt looks like, not to classify unusual
// symbols.
const BREAKS = /[\s,.;:!?'"()[\]{}<>/\\|@#$%^&*+=~`-]/;

const isBreak = (char: string): boolean => BREAKS.test(char);

// Tail of a word deletion: the separators after the word go with it, then the
// word itself stops at the next separator. Trailing spaces first so
// "hola mundo " loses the trailing space too, and a press on a run of spaces
// only eats that run.
const wordStart = (text: string): number => {
  let end = text.length;

  while (end > 0 && isBreak(text[end - 1]!)) end--;
  while (end > 0 && !isBreak(text[end - 1]!)) end--;

  return end;
};

// The draft after one backspace. `kind` is the caller's call from the clock;
// this function only knows how to cut.
export const backspaceDraft = (draft: string, kind: BackspaceKind): string => {
  if (!draft) return draft;

  return kind === "word" ? draft.slice(0, wordStart(draft)) : draft.slice(0, -1);
};

export interface Burst {
  // When the press being handled landed.
  at: number;
  // When the burst it belongs to started.
  startedAt: number;
}

// State of a press of backspace, given the previous one and the clock. Two
// presses further apart than BURST_GAP_MS are two intentions: the old burst
// is over and a new one starts. Nothing here renders; the caller keeps the
// result in a ref.
export const pressBurst = (previous: Burst | null, now: number): Burst => {
  if (previous && now - previous.at <= BURST_GAP_MS) {
    return { at: now, startedAt: previous.startedAt };
  }

  return { at: now, startedAt: now };
};

// Character until the burst has lasted long enough, a word from then on.
export const backspaceKind = (burst: Burst): BackspaceKind =>
  burst.at - burst.startedAt >= WORD_DELETE_AFTER_MS ? "word" : "char";
