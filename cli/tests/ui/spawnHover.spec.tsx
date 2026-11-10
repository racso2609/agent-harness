// The strip highlight has its own pure tests for the row arithmetic; these
// mount the real App and assert what the terminal is actually written. That
// distinction matters: ink skips the repaint when the text of the frame did not
// change, so a highlight built only out of style reached no screen at all while
// every pure test stayed green. Only a render can see it.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { App, type TuiLine, type TuiSpawn, type TuiState } from "../../src/ui/tui/App";
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

// ANSI-stripped text of the most recent complete frame. See scrollRender.spec
// for why the frame is taken from the last erase and not from a "ready"
// segment.
const frameOf = (chunks: string[]): string => {
  // SGR mouse reports go first, and before anything is stripped: the "<" of a
  // report such as ESC [ <35;10;10M is code point U+256D, the same one the
  // borders are drawn with, so a report left in the text passes for a border.
  const raw = chunks.join("").replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "");
  const erase = raw.lastIndexOf("\u001b[2K");
  const last = erase === -1 ? raw : raw.slice(erase + "\u001b[2K".length);

  return last.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
};

const notices = (labels: string[]): TuiLine[] =>
  labels.map((text) => ({ role: "notice" as const, text }));

const child = (id: string, status: string, extra: Partial<TuiSpawn> = {}): TuiSpawn => ({
  id,
  agent: "helper",
  status,
  ...extra,
});

const mount = (
  spawns: TuiSpawn[],
  lines: TuiLine[] = notices(["hello"]),
  history: TuiSpawn[] = [],
) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(20, 60);
  const state: TuiState = {
    lines,
    status: {},
    spawns,
    history,
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
    raw: () => chunks.join(""),
    // 1-based terminal row of the last painted line that mentions `id`. Read off
    // the frame itself instead of recomputing the chrome arithmetic: a test that
    // hard-codes the layout would go green the day the layout moves and the
    // report lands somewhere else.
    rowOf: (id: string): number => {
      const rows = frameOf(chunks).split("\n");
      const index = rows.findIndex((line) => line.includes(id));
      if (index === -1) throw new Error(`no row paints ${id}:\n${rows.join("\n")}`);
      return index + 1;
    },
    unmount: () => instance.unmount(),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Bare motion, what `?1003h` sends: no button pressed, nothing held.
const move = (row: number, col = 3) => `\u001b[<35;${col};${row}m`;
// Glyph the highlight swaps the separator for, so the row reads as the one a
// click would act on.
const HOVER_GLYPH = "›";

describe("the spawn strip hover", () => {
  it("paints the row under a bare motion report", async () => {
    const app = mount([child("aaa", "running"), child("bbb", "running")]);
    await settle();

    app.stdin.write(move(app.rowOf("aaa")));
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain(HOVER_GLYPH);
    const hovered = frame.split("\n").find((line) => line.includes("aaa"))!;
    const other = frame.split("\n").find((line) => line.includes("bbb"))!;
    expect(hovered).toContain(HOVER_GLYPH);
    expect(other).not.toContain(HOVER_GLYPH);
  });

  it("clears the highlight when the pointer leaves the strip", async () => {
    const app = mount([child("aaa", "running"), child("bbb", "running")]);
    await settle();

    app.stdin.write(move(app.rowOf("aaa")));
    await settle();
    expect(app.frame()).toContain(HOVER_GLYPH);

    // Row 1 is the top border of the transcript panel: inside the frame, far
    // outside the strip.
    app.stdin.write(move(1));
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).not.toContain(HOVER_GLYPH);
  });

  it("never highlights a settled or a restored child", async () => {
    // A restored child comes from the history, not from the live handles: the
    // strip stamps `restored` on every row it takes from there.
    const app = mount([child("live1", "running"), child("done1", "done")], notices(["hello"]), [
      child("rest1", "running"),
    ]);
    await settle();

    // The positive anchor comes first: a running child of this run, in the same
    // layout, has to light up. Without it a geometry of `null` (or a tap that
    // never ran) would leave every row unlit too, and the assertions below would
    // pass for exactly the wrong reason.
    app.stdin.write(move(app.rowOf("live1")));
    await settle();
    const overLive = app.frame();
    app.stdin.write(move(app.rowOf("done1")));
    await settle();
    const overDone = app.frame();
    app.stdin.write(move(app.rowOf("rest1")));
    await settle();
    const overRestored = app.frame();
    app.unmount();

    expect(overLive).toContain(HOVER_GLYPH);
    expect(overDone).not.toContain(HOVER_GLYPH);
    expect(overRestored).not.toContain(HOVER_GLYPH);
  });

  it("does not highlight for a press or a release", async () => {
    // The highlight follows motion only, so a press and a release (which do
    // stop the child, see spawnClick.spec) must leave the row unlit.
    const app = mount([child("aaa", "running"), child("bbb", "running")]);
    await settle();

    const before = app.frame();
    const row = app.rowOf("aaa");
    app.stdin.write(`\u001b[<0;3;${row}M`);
    await settle();
    const afterPress = app.frame();
    app.stdin.write(`\u001b[<0;3;${row}m`);
    await settle();
    const afterRelease = app.frame();
    app.unmount();

    expect(afterPress).toBe(before);
    expect(afterRelease).toBe(before);
    expect(afterRelease).not.toContain(HOVER_GLYPH);
  });

  it("turns the any-event tracking off again when it unmounts", async () => {
    const app = mount([child("aaa", "running")]);
    await settle();
    const during = app.raw();
    app.unmount();

    expect(during).toContain("\u001b[?1003h");
    expect(app.raw()).toContain("\u001b[?1003l");
  });
});
