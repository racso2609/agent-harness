// The strip arithmetic has its pure tests in progress.spec, and the highlight
// that shares the same tap has render tests in spawnHover.spec. These cases
// mount the real App and send the click over stdin, because the decision that
// matters — a click on a running child of this process stops it, and nothing
// else does — lives in a tap installed outside React: a unit test of the
// callback would stay green with the tap wired to the wrong row.

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

// ANSI-stripped text of the most recent complete frame. SGR mouse reports go
// first, and before anything is stripped: the "<" of a report is the same code
// point the borders are drawn with, so a report left in the text passes for a
// border.
const frameOf = (chunks: string[]): string => {
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
  // A context every child carries, the way the core fills it on every handle.
  prompt: `work on ${id}`,
  ...extra,
});

const mount = (
  spawns: TuiSpawn[],
  options: {
    lines?: TuiLine[];
    history?: TuiSpawn[];
    onCancelSpawn?: (spawnId: string) => boolean;
  } = {},
) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(20, 60);
  const state: TuiState = {
    lines: options.lines ?? notices(["hello"]),
    status: {},
    spawns,
    history: options.history ?? [],
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
      onCancelSpawn={options.onCancelSpawn}
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
    // 1-based terminal row of the last painted line that mentions `id`. Read
    // off the frame instead of recomputing the chrome arithmetic, so the click
    // follows the layout wherever it moves.
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

// A left press: the only report that stops a child.
const click = (row: number, col = 3) => `\u001b[<0;${col};${row}M`;

describe("a click on the spawn strip", () => {
  it("stops the running child whose row was clicked, once", async () => {
    const onCancelSpawn = vi.fn();
    const app = mount([child("aaa", "running"), child("bbb", "running")], { onCancelSpawn });
    await settle();

    const row = app.rowOf("bbb");
    app.stdin.write(click(row));
    await settle();
    app.unmount();

    expect(onCancelSpawn).toHaveBeenCalledTimes(1);
    expect(onCancelSpawn).toHaveBeenCalledWith("bbb");
  });

  it("stays silent on a settled child, on a restored one and outside the strip", async () => {
    const onCancelSpawn = vi.fn();
    // A restored child comes from the history, not from the live handles: the
    // strip stamps `restored` on every row it takes from there. Six of them so
    // the strip also paints the "+N older" counter, which is a row of the box
    // and not a child.
    const app = mount([child("done1", "done")], {
      history: Array.from({ length: 7 }, (_, index) => child(`rest${index}`, "running")),
      onCancelSpawn,
    });
    await settle();

    app.stdin.write(click(app.rowOf("done1")));
    await settle();
    app.stdin.write(click(app.rowOf("rest6")));
    await settle();
    app.stdin.write(click(app.rowOf("older")));
    await settle();
    // Row 1 is the top border of the transcript panel: inside the frame, far
    // away from the strip.
    app.stdin.write(click(1));
    await settle();
    app.unmount();

    expect(onCancelSpawn).not.toHaveBeenCalled();
  });

  it("ignores the right button, a release and a drag", async () => {
    const onCancelSpawn = vi.fn();
    const app = mount([child("aaa", "running")], { onCancelSpawn });
    await settle();

    const row = app.rowOf("aaa");
    // Right press, left release and a left drag: none of them is a click.
    app.stdin.write(`\u001b[<2;3;${row}M`);
    await settle();
    app.stdin.write(`\u001b[<0;3;${row}m`);
    await settle();
    app.stdin.write(`\u001b[<32;3;${row}M`);
    await settle();
    app.unmount();

    expect(onCancelSpawn).not.toHaveBeenCalled();
  });

  it("hands every press of a running child over and lets the owner answer", async () => {
    // The race this guards: the frame on screen still lists the child as
    // running, and by the time the click lands the child has settled. The owner
    // then aborts nothing and says so; the app must not drop that answer on the
    // way back. The tap is the only door between the two, so the case checks it
    // is still open in both directions: one call in, one answer out.
    const answered: string[] = [];
    const onCancelSpawn = vi.fn((spawnId: string) => {
      answered.push(spawnId);

      return false;
    });
    const app = mount([child("aaa", "running")], { onCancelSpawn });
    await settle();

    app.stdin.write(click(app.rowOf("aaa")));
    await settle();
    app.unmount();

    expect(onCancelSpawn).toHaveBeenCalledWith("aaa");
    // Nothing was swallowed: the owner's answer reached the loop exactly once.
    expect(answered).toEqual(["aaa"]);
  });

  it("does nothing at all when no owner asked to be told", async () => {
    // The prop is optional on purpose: a caller with nothing to stop must be
    // able to leave it out without the click throwing.
    const app = mount([child("aaa", "running")]);
    await settle();

    expect(() => app.stdin.write(click(app.rowOf("aaa")))).not.toThrow();
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("aaa");
  });

  it("does not move the transcript", async () => {
    const onCancelSpawn = vi.fn();
    const lines = notices(Array.from({ length: 40 }, (_, index) => `line-${index}`));
    const app = mount([child("aaa", "running")], { lines, onCancelSpawn });
    await settle();

    const before = app.frame();
    app.stdin.write(click(app.rowOf("aaa")));
    await settle();
    const after = app.frame();
    app.unmount();

    // The click stopped the child and left the window where the user put it.
    expect(onCancelSpawn).toHaveBeenCalledWith("aaa");
    expect(after).toBe(before);
  });
});
