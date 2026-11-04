// Mouse wheel parsing. Ink 8 does not surface mouse events, so the TUI reads
// SGR reports straight off stdin; this is the pure half that turns a raw chunk
// into the scroll deltas the view should apply.

import { describe, expect, it } from "vitest";
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  WHEEL_LINES,
  wheelScrollLines,
} from "../../src/ui/tui/viewport";

describe("wheelScrollLines", () => {
  it("reads one notch up as a positive delta", () => {
    expect(wheelScrollLines("\u001b[<64;10;10M")).toEqual([WHEEL_LINES]);
  });

  it("reads one notch down as a negative delta", () => {
    expect(wheelScrollLines("\u001b[<65;10;10M")).toEqual([-WHEEL_LINES]);
  });

  it("keeps every notch when the terminal batches them in one chunk", () => {
    expect(wheelScrollLines("\u001b[<64;1;1M\u001b[<64;1;1M\u001b[<65;1;1M")).toEqual([
      WHEEL_LINES,
      WHEEL_LINES,
      -WHEEL_LINES,
    ]);
  });

  it("ignores clicks, releases and drags so they cannot move the transcript", () => {
    // 0 = left press, 0 release (`m`), 32 = drag with the left button held.
    expect(wheelScrollLines("\u001b[<0;5;5M\u001b[<0;5;5m\u001b[<32;6;6M")).toEqual([]);
  });

  it("returns nothing for ordinary keys, including a bare escape", () => {
    expect(wheelScrollLines("\u001b[Aabc\u001b")).toEqual([]);
  });

  it("exposes a matching enable/disable pair", () => {
    expect(MOUSE_ENABLE).toContain("1000h");
    expect(MOUSE_ENABLE).toContain("1006h");
    expect(MOUSE_DISABLE).toContain("1000l");
    expect(MOUSE_DISABLE).toContain("1006l");
  });
});
