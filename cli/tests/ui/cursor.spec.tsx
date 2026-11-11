// The insertion point of the input box is a painted glyph, not a style, and
// that is the whole point of it: ink compares the plain text of the frame to
// decide whether to write (ink@8.0.0/build/ink.js:476-480), so a cursor that
// only differed in colour would produce an identical frame and never reach the
// screen. A pure test of the blink state cannot see that, so these cases mount
// the real App on a stand-in terminal and read the frame it writes.
//
// The blink is driven by `setInterval`, and only by it: the fake timers below
// fake that one function and nothing else. Ink flushes its output through
// `setImmediate` and throttles it with `setTimeout`, so faking those as well
// would freeze the renderer and every assertion would read a stale frame.

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { App, type TuiLine, type TuiState } from "../../src/ui/tui/App";
import { resolveTheme } from "../../src/ui/tui/theme";

// Glyph of the insertion point. `BLINK_MS` is not exported by App, so the
// period is repeated here: the test has to advance the clock by exactly one
// half of the blink, and a literal is the only way to do it from outside.
const CURSOR_GLYPH = "\u258F";
const BLINK_MS = 500;

const fakeStdin = () => {
  const stream = new PassThrough() as PassThrough & Record<string, unknown>;
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
};

const fakeStdout = (rows: number, columns: number) => {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & Record<string, unknown>;
  stream.isTTY = true;
  stream.rows = rows;
  stream.columns = columns;
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    chunks.push(chunk);
    return write(chunk);
  }) as typeof stream.write;
  return { stream, chunks };
};

// ANSI-stripped text of the most recent complete frame, taken from the last
// erase the way the other ink render tests do.
const frameOf = (chunks: string[]): string => {
  const raw = chunks.join("").replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "");
  const erase = raw.lastIndexOf("\u001b[2K");
  const last = erase === -1 ? raw : raw.slice(erase + "\u001b[2K".length);

  return last.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
};

const notices = (labels: string[]): TuiLine[] =>
  labels.map((text) => ({ role: "notice" as const, text }));

const mount = (overrides: Partial<TuiState> = {}, sent: string[] = []) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(20, 60);
  const state: TuiState = {
    lines: notices(["hello"]),
    status: {},
    spawns: [],
    history: [],
    theme: resolveTheme(),
    expanded: new Set<number>(),
    ...overrides,
  };
  const instance = render(
    <App
      state={state}
      onSubmit={(prompt) => sent.push(prompt)}
      onExit={() => {}}
      onDecision={() => {}}
      onToggle={() => {}}
      onToggleAll={() => {}}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  return {
    stdin,
    sent,
    frame: () => frameOf(chunks),
    // Rows of the painted frame. The layout must not grow or shrink when the
    // cursor goes dark, so the count is what the height case compares.
    rows: () => frameOf(chunks).split("\n").length,
    unmount: () => instance.unmount(),
  };
};

// Real timers on purpose: ink flushes through `setImmediate` and `setTimeout`,
// and the fake clock below leaves both of them alone.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => {
  // Without this the fake clock leaks into the next case and its `settle()`
  // never resolves.
  vi.useRealTimers();
});

describe("the cursor of the input box", () => {
  it("paints the glyph in an empty box", async () => {
    const app = mount();
    await settle();
    const frame = app.frame();
    app.unmount();

    // The empty box is the case where the cursor is the only thing to see: a
    // render that dropped the glyph would leave a bare "> " and nothing else.
    expect(frame).toContain(`> ${CURSOR_GLYPH}`);
  });

  it("keeps the glyph after the typed text", async () => {
    const app = mount();
    await settle();

    app.stdin.write("hi");
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain(`> hi${CURSOR_GLYPH}`);
  });

  it("never lets the glyph into the text handed to onSubmit", async () => {
    const app = mount();
    await settle();

    app.stdin.write("hi");
    await settle();
    // The positive anchor: the glyph is on screen right before the send, so a
    // green result below cannot come from a box that never painted a cursor.
    expect(app.frame()).toContain(CURSOR_GLYPH);

    app.stdin.write("\r");
    await settle();
    const sent = [...app.sent];
    app.unmount();

    // Exactly what was typed: the glyph is painted next to the draft, never
    // appended to it.
    expect(sent).toEqual(["hi"]);
  });

  it("does not change the height of the layout when it goes dark", async () => {
    // Only `setInterval` is faked: the blink is an interval, while ink's own
    // flush and throttle are `setImmediate` and `setTimeout` and must keep
    // running or no frame would ever be written.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const app = mount();
    await settle();
    const lit = app.frame();
    const litRows = app.rows();

    // One half of the blink: the interval flips `cursorOn` and the App repaints.
    vi.advanceTimersByTime(BLINK_MS);
    await settle();
    const dark = app.frame();
    const darkRows = app.rows();
    app.unmount();

    // Positive anchor first: the two frames really are the two halves of the
    // blink, otherwise "same height" would be true of one frame compared to
    // itself.
    expect(lit).toContain(CURSOR_GLYPH);
    expect(dark).not.toContain(CURSOR_GLYPH);
    // The dark half is the draft alone, so the box keeps its row and the
    // transcript below it does not jump twice a second.
    expect(dark).toContain("> ");
    expect(darkRows).toBe(litRows);
  });

  it("paints no cursor while a picker owns the box", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const app = mount({
      selection: {
        message: "Select the model:",
        options: [
          { id: "model-a", label: "gpt-a" },
          { id: "model-b", label: "gpt-b" },
        ],
      },
    });
    await settle();

    // The tick is not mounted here, so advancing the clock changes nothing: the
    // box is replaced by the picker and there is no insertion point to light.
    vi.advanceTimersByTime(BLINK_MS * 2);
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("Select the model:");
    expect(frame).not.toContain(CURSOR_GLYPH);
  });

  it("paints no cursor while a question owns the box", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const app = mount({
      prompt: { kind: "text", message: "Provider id:" },
    });
    await settle();

    vi.advanceTimersByTime(BLINK_MS * 2);
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("Provider id:");
    expect(frame).not.toContain(CURSOR_GLYPH);
  });
});
