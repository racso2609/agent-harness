// The scroll model has its own pure tests; these mount the real App on ink and
// assert what the pane paints. Two bugs lived only here: Yoga shrinking rows
// when the content overflowed (lines vanished and overlapped) and the first row
// of the window being painted from its top instead of from the cut point. A
// pure test cannot see either, because they are facts about the render.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { App, type TuiLine, type TuiState } from "../../src/ui/tui/App";
import { resolveTheme } from "../../src/ui/tui/theme";

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

// ANSI-stripped text of the most recent complete frame. Counting on a "ready"
// after the last one does not work: the TUI also writes its mouse-mode
// sequences on mount and ink flushes them as their own chunks, so how many
// "ready" segments there are is not a fact about the frame. What is stable is
// the transcript panel itself: the frame is the last panel, borders included.
const frameOf = (chunks: string[]): string => {
  // SGR mouse reports go first, and before anything is stripped: the "<" of a
  // report such as ESC [ <64;10;10M is code point U+256D, the same one the
  // borders are drawn with, so a report left in the text passes for a border.
  const raw = chunks.join("").replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "");
  // Ink does not repaint the screen, it erases a line at a time and writes only
  // what changed, so the output holds every frame the app ever painted and the
  // last complete one begins at the last erase. Counting "ready" segments does
  // not work here: the mouse-mode sequences written on mount are flushed as
  // chunks of their own and change how many segments there are.
  const erase = raw.lastIndexOf("\u001b[2K");
  const last = erase === -1 ? raw : raw.slice(erase + "\u001b[2K".length);

  return last.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
};

const notices = (labels: string[]): TuiLine[] =>
  labels.map((text) => ({ role: "notice" as const, text }));

const mount = (lines: TuiLine[], rows = 20, columns = 30) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(rows, columns);
  const state: TuiState = {
    lines,
    status: {},
    spawns: [],
    history: [],
    theme: resolveTheme(),
    expanded: new Set<number>(),
  };
  const instance = render(
    <App
      state={state}
      onSubmit={() => {}}
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
    frame: () => frameOf(chunks),
    unmount: () => instance.unmount(),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("the transcript pane", () => {
  it("keeps the newest lines of a tall entry visible at the bottom", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => `row${String(index).padStart(2, "0")}`);
    const app = mount([{ role: "user", text: rows.join("\n") }, ...notices(["tail"])]);

    await settle();
    const frame = app.frame();
    app.unmount();

    // The pane is six rows; the bottom must show the end of the entry, not its
    // first lines, which is what a shrink/clip from the top would paint.
    expect(frame).toContain("row11");
    expect(frame).not.toContain("row00");
    expect(frame).not.toContain("row01");
  });

  it("clips the top of a tall entry instead of overlapping the row below", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => `row${String(index).padStart(2, "0")}`);
    const app = mount([{ role: "user", text: rows.join("\n") }, ...notices(["a", "b"])]);

    await settle();
    // Scroll up until the window starts inside the tall entry.
    for (let i = 0; i < 4; i++) app.stdin.write("\u001b[A");
    await settle();
    const frame = app.frame();
    app.unmount();

    const lines = frame.split("\n").filter((line) => line.includes("│"));
    // No painted row may carry two entries: that is the Yoga shrink overlap.
    for (const line of lines) {
      expect(line).not.toMatch(/row\d\d.*[a-z]/i);
    }
    // The visible window moved, so the first lines are gone.
    expect(frame).not.toContain("row00");
  });

  it("moves three lines per wheel notch and leaves the draft empty", async () => {
    const labels = Array.from({ length: 40 }, (_, index) => `r${String(index).padStart(2, "0")}`);
    const app = mount(notices(labels));

    await settle();
    expect(app.frame()).toContain("r39");

    app.stdin.write("\u001b[<64;10;10M");
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).not.toContain("r39");
    expect(frame).toContain("r35");
    // A mouse report must not leak into the input box as typed text.
    expect(frame).not.toContain("64;10");
  });
});
