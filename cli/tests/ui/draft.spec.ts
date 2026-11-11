// The draft's backspace rules are pure, so they are tested here instead of
// through a mounted ink box: the whole heuristic is a clock, and a test that
// passes `now` by hand is the only way to pin the two windows down without
// timers. App.tsx feeds these functions a `useRef<Burst | null>` and
// `Date.now()`; every case below is a sequence of presses the App would have
// produced.

import { describe, expect, it } from "vitest";
import {
  BURST_GAP_MS,
  backspaceDraft,
  backspaceKind,
  type Burst,
  pressBurst,
  WORD_DELETE_AFTER_MS,
} from "../../src/ui/tui/draft";

// One press of backspace as the App handles it: advance the burst, ask what
// kind of deletion it is, and cut the draft. Returns the new draft and the
// state the ref would hold.
const press = (draft: string, previous: Burst | null, now: number) => {
  const burst = pressBurst(previous, now);
  const kind = backspaceKind(burst);

  return { draft: backspaceDraft(draft, kind), burst, kind };
};

// A burst that started at 0 and is still running at `at`.
const burstAt = (at: number, startedAt = 0): Burst => ({ at, startedAt });

describe("pressBurst", () => {
  it("starts a new burst on the first press", () => {
    expect(pressBurst(null, 1_000)).toEqual({ at: 1_000, startedAt: 1_000 });
  });

  it("keeps the original start while the gap stays under the window", () => {
    const first = pressBurst(null, 1_000);
    const second = pressBurst(first, 1_000 + BURST_GAP_MS - 1);

    expect(second).toEqual({ at: 1_000 + BURST_GAP_MS - 1, startedAt: 1_000 });
  });

  it("treats a gap of exactly BURST_GAP_MS as the same burst (the check is <=)", () => {
    const first = pressBurst(null, 1_000);
    const second = pressBurst(first, 1_000 + BURST_GAP_MS);

    expect(second.startedAt).toBe(1_000);
  });

  it("starts over once the gap passes BURST_GAP_MS", () => {
    const first = pressBurst(null, 1_000);
    const now = 1_000 + BURST_GAP_MS + 1;

    expect(pressBurst(first, now)).toEqual({ at: now, startedAt: now });
  });
});

describe("backspaceKind", () => {
  it("deletes a character while the burst is younger than the word window", () => {
    expect(backspaceKind(burstAt(WORD_DELETE_AFTER_MS - 1))).toBe("char");
  });

  it("deletes a word at exactly WORD_DELETE_AFTER_MS (the check is >=)", () => {
    expect(backspaceKind(burstAt(WORD_DELETE_AFTER_MS))).toBe("word");
  });

  it("deletes a word for a long burst", () => {
    expect(backspaceKind(burstAt(WORD_DELETE_AFTER_MS * 10))).toBe("word");
  });
});

describe("backspaceDraft", () => {
  it("removes one character for a char deletion", () => {
    expect(backspaceDraft("hola", "char")).toBe("hol");
  });

  it("returns the empty draft untouched", () => {
    expect(backspaceDraft("", "char")).toBe("");
    expect(backspaceDraft("", "word")).toBe("");
  });

  it("removes the last word and the separators after it", () => {
    expect(backspaceDraft("hola mundo", "word")).toBe("hola ");
  });

  it("removes a single-word draft entirely", () => {
    expect(backspaceDraft("hola", "word")).toBe("");
  });

  it("splits on the comma of a sentence", () => {
    // The comma belongs to the word before it, so it stays.
    expect(backspaceDraft("hola, mundo", "word")).toBe("hola, ");
  });

  it("keeps the run of spaces before the word it removes", () => {
    expect(backspaceDraft("a b", "word")).toBe("a ");
  });

  it("keeps the leading spaces of a one-word draft", () => {
    expect(backspaceDraft(" hola", "word")).toBe(" ");
  });
});

describe("a sequence of presses", () => {
  it("deletes one character for an isolated tap", () => {
    const { draft, kind } = press("hola", null, 0);

    expect(kind).toBe("char");
    expect(draft).toBe("hol");
  });

  it("keeps deleting characters for two quick taps under the word window", () => {
    // Both taps land inside WORD_DELETE_AFTER_MS of the burst's start, so the
    // burst is young enough that each one still takes a single character.
    const first = press("hola", null, 0);
    const second = press(first.draft, first.burst, WORD_DELETE_AFTER_MS - 1);

    expect(first.kind).toBe("char");
    expect(second.kind).toBe("char");
    expect(second.draft).toBe("ho");
  });

  it("takes a word when the second tap lands between the two windows", () => {
    // A gap under BURST_GAP_MS keeps the burst alive, but the burst is now old
    // enough to swallow a word: the two windows are independent, and this is
    // the band where a "double tap" already deletes a word.
    const first = press("hola mundo", null, 0);
    const second = press(first.draft, first.burst, WORD_DELETE_AFTER_MS);

    expect(second.kind).toBe("word");
    expect(second.draft).toBe("hola ");
  });

  it("swallows a word once the burst outlives the word window", () => {
    // A held key: presses every 100ms, so the burst is still one burst, and by
    // the fifth press it has lasted long enough to take a word.
    let draft = "hola mundo";
    let burst: Burst | null = null;
    let kind = "char";

    for (let now = 0; now <= WORD_DELETE_AFTER_MS; now += 100) {
      const step = press(draft, burst, now);
      draft = step.draft;
      burst = step.burst;
      kind = step.kind;
    }

    expect(kind).toBe("word");
    expect(draft).toBe("hola ");
  });

  it("goes back to characters after the burst is cut", () => {
    const first = press("hola mundo", null, 0);
    const held = press(first.draft, first.burst, WORD_DELETE_AFTER_MS);
    // A pause longer than the gap: the next press is a new intention.
    const after = press(held.draft, held.burst, WORD_DELETE_AFTER_MS + BURST_GAP_MS + 1);

    expect(held.kind).toBe("word");
    expect(held.draft).toBe("hola ");
    expect(after.kind).toBe("char");
    expect(after.draft).toBe("hola");
  });

  it("does not break on a word deletion of an empty draft", () => {
    const started = pressBurst(null, 0);
    const { draft, kind } = press("", started, WORD_DELETE_AFTER_MS);

    expect(kind).toBe("word");
    expect(draft).toBe("");
  });
});

describe("unicode", () => {
  it("removes an accented character whole", () => {
    expect(backspaceDraft("café", "char")).toBe("caf");
  });

  it("removes a word that ends in an emoji whole", () => {
    expect(backspaceDraft("hola 😀", "word")).toBe("hola ");
  });

  it("does not split an emoji in half on a char deletion", () => {
    // A lone surrogate is not a character: the box would render a replacement
    // glyph. The cut counts code points, so the whole emoji goes in one press.
    expect(backspaceDraft("hola 😀", "char")).toBe("hola ");
  });

  it("removes an astral character from an emoji-only draft", () => {
    expect(backspaceDraft("😀", "char")).toBe("");
  });

  it("never leaves a lone surrogate behind", () => {
    // A pair is two code units; a cut between them would leave one of these.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const kind of ["char", "word"] as const) {
      expect(lone.test(backspaceDraft("hi 😀", kind))).toBe(false);
    }
  });

  it("takes a two-code-point emoji one code point per press, leaving valid text", () => {
    // "👍🏽" is the thumb plus a skin-tone modifier: two code points, so two
    // presses. Each step is a well-formed string, and the first one is the
    // plain thumb, which still renders as a character.
    const once = backspaceDraft("👍🏽", "char");

    expect(once).toBe("👍");
    expect(backspaceDraft(once, "char")).toBe("");
  });
});

// The word boundaries the module comment promises: only whitespace separates
// words, so the punctuation the user typed inside a token stays with it, and a
// run of spaces at the end of the draft is deleted on its own.
describe("word boundaries", () => {
  it("removes a dotted name in one go", () => {
    expect(backspaceDraft("foo.ts", "word")).toBe("");
  });

  it("removes a slash command in one go", () => {
    expect(backspaceDraft("/resume", "word")).toBe("");
  });

  it("removes a path in one go", () => {
    expect(backspaceDraft("src/ui/draft.ts", "word")).toBe("");
  });

  it("eats only the run of spaces when the draft ends in spaces", () => {
    expect(backspaceDraft("hola ", "word")).toBe("hola");
  });

  it("eats only the run of spaces when the run is all there is", () => {
    expect(backspaceDraft("   ", "word")).toBe("");
  });

  it("takes a word and the single space before it, keeping that space", () => {
    expect(backspaceDraft("hola mundo", "word")).toBe("hola ");
  });

  it("keeps the trailing punctuation of the word before the one it removes", () => {
    // The comma is glued to "hola", so it goes with "hola", not with "mundo".
    expect(backspaceDraft("hola, mundo", "word")).toBe("hola, ");
  });
});
