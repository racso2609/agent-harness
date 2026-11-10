// Editing the draft has pure tests for the pieces, but only a mount shows that
// a control key reaches the box at all: `useInput` is ink's parser plus the
// App's branches, and a key swallowed by an earlier branch looks exactly like a
// key that was never typed. The frame is the evidence here, the same way it is
// in scrollRender.spec and spawnHover.spec.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import type { CommandOption } from "@/commands/CommandRepository";
import { App, type TuiState } from "../../src/ui/tui/App";
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

const commands: CommandOption[] = [
  { name: "help", aliases: ["?"], description: "List available commands" },
  { name: "resume", description: "Resume a session" },
];

// Ctrl-U as a terminal writes it: one chunk holding 0x15.
const CTRL_U = "\u0015";
const DRAFT = "hola mundo";

const mount = (overrides: Partial<TuiState> = {}) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(20, 60);
  const state: TuiState = {
    lines: [],
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
      commands={commands}
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

describe("ctrl+u in the input box", () => {
  it("wipes the whole draft at once", async () => {
    const app = mount();
    await settle();

    app.stdin.write(DRAFT);
    await settle();
    // The text has to reach the box first: without this anchor a box that never
    // took the keystrokes would look emptied by the next assertion.
    expect(app.frame()).toContain(DRAFT);

    app.stdin.write(CTRL_U);
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).not.toContain(DRAFT);
  });

  it("leaves the next slash opening the dropdown again", async () => {
    const app = mount();
    await settle();

    // Closing the list on purpose is what makes the reopening observable: the
    // dismissed query is "/res", the same one the user is about to type again.
    app.stdin.write("/res");
    await settle();
    expect(app.frame()).toContain("Resume a session");

    app.stdin.write("\u001b");
    await settle();
    expect(app.frame()).not.toContain("Resume a session");

    // Esc then ctrl+u from the same box: emptying it must lift the dismissal, the
    // way a backspace to nothing does.
    app.stdin.write(CTRL_U);
    await settle();
    app.stdin.write("/res");
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("Resume a session");
  });
});
