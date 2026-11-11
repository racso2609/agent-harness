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

// Word boundaries. The draft is a prompt, not prose: `foo.ts` or `/resume` are
// single things the user wrote on purpose and want gone in one go, so the
// punctuation inside a token does not split it. Only whitespace separates
// words. Punctuation glued to the end of a token belongs to that token and
// leaves with it: `hola, mundo` deletes `mundo`, then the space, then `hola,`.
const isSpace = (char: string): boolean => /\s/.test(char);

// Start index of what a `word` deletion removes, counting code points so a
// slice here can never land inside a surrogate pair. A "word" is a run of
// non-space code points; the punctuation inside it is part of it. Two rules,
// in order:
//
// 1. When the draft ends in spaces, those spaces are the token under the
//    cursor, so the press eats only that run: `"hola "` becomes `"hola"` and
//    `"   "` becomes `""`.
// 2. Otherwise the trailing word goes, and so do the spaces in front of it
//    (each of those spaces is the separator between the two words):
//    `"hola mundo "` becomes `"hola "` and `"src/ui/draft.ts"` becomes `""`.
//    A single space before the word survives, because it is the last character
//    of what was already there: `"a b"` becomes `"a "`.
const wordStart = (text: string): number => {
  const chars = Array.from(text);
  let end = chars.length;

  // Rule 1: the draft ends in spaces. That run is the token under the
  // cursor, so the press eats it and stops there.
  let runStart = end;
  while (runStart > 0 && isSpace(chars[runStart - 1]!)) runStart--;
  if (runStart < end) return runStart;
  // Rule 2: the draft ends in a word. Take the word and the spaces that
  // separated it from the word before, keeping the last of those spaces:
  // `"hola mundo "` loses `"mundo "` and `"a b"` loses `"b"`.
  end = runStart;
  while (end > 0 && !isSpace(chars[end - 1]!)) end--;
  while (end > 1 && isSpace(chars[end - 1]!) && isSpace(chars[end - 2]!)) end--;

  return end;
};

// Index just past the last code point of the draft: one character for a `char`
// deletion. Counting code points keeps the surrogate pairs of astral
// characters whole, so an emoji is deleted in one press instead of leaving a
// lone surrogate that ink would paint as U+FFFD. A grapheme cluster (an emoji
// with a skin-tone modifier, a ZWJ family, a letter plus its combining accent)
// is several code points and therefore several presses; each one leaves a
// valid string behind, which is the guarantee this function makes.
const charStart = (text: string): number => {
  const chars = Array.from(text);

  return chars.slice(0, -1).join("").length;
};

// The draft after one backspace. `kind` is the caller's call from the clock;
// this function only knows how to cut.
export const backspaceDraft = (draft: string, kind: BackspaceKind): string => {
  if (!draft) return draft;

  return kind === "word" ? draft.slice(0, wordStart(draft)) : draft.slice(0, charStart(draft));
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
