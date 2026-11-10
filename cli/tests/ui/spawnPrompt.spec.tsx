// What the strip actually writes to the terminal. The pure tests in
// progress.spec cover the clipping rule, but they cannot see whether the row
// paints the context at all, nor whether a long prompt pushed the row onto a
// second terminal line — the one thing that would silently desynchronise the
// mouse hit-test, which assumes one painted row per child.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { App, type TuiLine, type TuiSpawn, type TuiState } from "../../src/ui/tui/App";
import { PROMPT_COLUMNS } from "../../src/ui/tui/progress";
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
  const raw = chunks.join("").replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, "");
  const erase = raw.lastIndexOf("\u001b[2K");
  const last = erase === -1 ? raw : raw.slice(erase + "\u001b[2K".length);

  return last.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
};

const notices = (labels: string[]): TuiLine[] =>
  labels.map((text) => ({ role: "notice" as const, text }));

const child = (id: string, prompt: string): TuiSpawn => ({
  id,
  agent: "coder",
  prompt,
  status: "running",
});

const mount = (spawns: TuiSpawn[]) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(20, 80);
  const state: TuiState = {
    lines: notices(["hello"]),
    status: {},
    spawns,
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
    // The terminal row of the last painted line that mentions `id`, read off
    // the frame instead of recomputed, so it follows the layout wherever it
    // moves.
    rowOf: (id: string): string => {
      const row = frameOf(chunks)
        .split("\n")
        .find((line) => line.includes(id));

      if (row === undefined) throw new Error(`no row paints ${id}:\n${frameOf(chunks)}`);

      return row;
    },
    frame: () => frameOf(chunks),
    unmount: () => instance.unmount(),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("the context on a child row", () => {
  it("paints the prompt, so two coder children read apart", async () => {
    const app = mount([child("aaa", "fix the login bug"), child("bbb", "add the logout test")]);
    await settle();

    const first = app.rowOf("aaa");
    const second = app.rowOf("bbb");
    app.unmount();

    expect(first).toContain("(fix the login bug)");
    expect(second).toContain("(add the logout test)");
  });

  it("clips a huge prompt to one line instead of wrapping the row", async () => {
    const prompt = Array.from(
      { length: 20 },
      (_, index) => `line ${index} of a very long ask`,
    ).join("\n");
    const app = mount([child("aaa", prompt), child("bbb", "short ask")]);
    await settle();

    const frame = app.frame();
    app.unmount();

    const rows = frame.split("\n");
    // One row per child: a wrapped row would push the next child down and the
    // mouse hit-test would then land on the wrong one.
    const painted = rows.filter((row) => row.includes("aaa") || row.includes("bbb"));

    expect(painted).toHaveLength(2);
    expect(rows.some((row) => row.includes("line 1 of a very long"))).toBe(false);
    expect(painted.find((row) => row.includes("aaa"))).toContain("…");
    expect(painted.find((row) => row.includes("aaa"))).toContain("line 0 of a very long");
  });

  it("keeps the clipped context within the reserved columns", async () => {
    const app = mount([child("aaa", "a".repeat(200))]);
    await settle();

    const row = app.rowOf("aaa");
    app.unmount();

    const painted = /\(([^)]*)\)/.exec(row)?.[1] ?? "";

    expect(painted).toHaveLength(PROMPT_COLUMNS);
  });
});
