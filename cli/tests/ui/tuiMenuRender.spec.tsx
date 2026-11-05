import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import type { CommandOption } from "../../src/commands/CommandRepository";
import { App, type TuiState } from "../../src/ui/tui/App";
import { resolveTheme } from "../../src/ui/tui/theme";

// The dropdown and the picker are painted by the real App: their geometry is
// arithmetic (viewport.spec.ts) and their model is pure (commandMenu.spec.ts),
// but only a mount shows the panel appearing under the box when "/" is typed
// and the picker replacing it. Ink writes to a fake stream here for the same
// reason as scrollRender.spec.tsx: no TTY in CI.

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

const frameOf = (chunks: string[]): string => {
  const clean = chunks.join("").replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");

  return clean.split("ready").at(-2) ?? "";
};

const commands: CommandOption[] = [
  { name: "help", aliases: ["?"], description: "List available commands" },
  { name: "model", description: "Switch the active model" },
  { name: "resume", description: "Resume a session" },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const mount = (overrides: Partial<TuiState> = {}, sent: string[] = []) => {
  const stdin = fakeStdin();
  const { stream: stdout, chunks } = fakeStdout(30, 60);
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
    unmount: () => instance.unmount(),
  };
};

describe("the dropdown on screen", () => {
  it("paints the matching commands once a slash is typed", async () => {
    const app = mount();

    await settle();
    // A bare prompt shows no list at all.
    expect(app.frame()).not.toContain("List available commands");

    app.stdin.write("/");
    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("/help");
    expect(frame).toContain("List available commands");
    expect(frame).toContain("tab complete");
  });

  it("narrows the list as the query grows and says so when nothing matches", async () => {
    const app = mount();

    app.stdin.write("/mo");
    await settle();
    const filtered = app.frame();

    app.stdin.write("zzz");
    await settle();
    const empty = app.frame();
    app.unmount();

    expect(filtered).toContain("/model");
    expect(filtered).not.toContain("/resume");
    expect(empty).toContain("no matching commands");
  });

  it("sends the highlighted command when enter runs it", async () => {
    const app = mount();

    app.stdin.write("/res");
    await settle();
    app.stdin.write("\r");
    await settle();
    const sent = app.sent;
    app.unmount();

    expect(sent).toEqual(["/resume"]);
  });
});

describe("the picker on screen", () => {
  it("replaces the input box with the question and its options", async () => {
    const app = mount({
      selection: {
        message: "Select the model:",
        options: [
          { id: "model-a", label: "gpt-a", hint: "fast" },
          { id: "model-b", label: "gpt-b" },
        ],
      },
    });

    await settle();
    const frame = app.frame();
    app.unmount();

    expect(frame).toContain("Select the model:");
    expect(frame).toContain("gpt-a — fast");
    expect(frame).toContain("gpt-b");
    expect(frame).toContain("enter accept");
  });
});
