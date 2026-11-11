// The contract of the stdin tap in App: ink keeps its own parser in front of
// `stream.read` and pulls chunks from there, so the tap that reads the mouse
// sequences rewrites `read` and nothing else. A `data` listener would flip
// stdin to flowing mode and starve those paused reads, and a `pause`/`resume`
// would switch them off for good; both break the whole TUI in a way no mouse
// test catches, because the app still paints and simply stops reading keys.
//
// This file guards that contract from the outside, by mounting the real App
// on a stand-in stdin and watching what the stream is asked to do. It is a
// behaviour test on purpose: it does not read the source, it observes the
// stream. The tap itself is a closure inside a `useEffect` and is not
// exported, so the "the chunk comes back intact" half of the contract cannot
// be asserted on the tap directly; it is asserted through ink instead, which
// is the only other reader of the chunk.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { App, type TuiLine, type TuiSpawn, type TuiState } from "../../src/ui/tui/App";
import { resolveTheme } from "../../src/ui/tui/theme";

// Stand-in for the terminal's stdin. It is a `PassThrough` so a test can push
// bytes into it the way a terminal would, and every door the tap is forbidden
// to use is counted: `pause`, `resume` and any listener registered for "data".
// Raw mode is faked because ink turns it on as soon as an input hook mounts.
const spiedStdin = () => {
  const stream = new PassThrough() as PassThrough & Record<string, unknown>;
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};

  const calls = { pause: 0, resume: 0, dataListeners: 0 };

  const pause = stream.pause.bind(stream);
  stream.pause = (() => {
    calls.pause += 1;
    return pause();
  }) as typeof stream.pause;

  const resume = stream.resume.bind(stream);
  stream.resume = (() => {
    calls.resume += 1;
    return resume();
  }) as typeof stream.resume;

  // Only "data" is counted: ink listens for "readable" itself, and an app that
  // reads its keys legitimately has that listener on the stream.
  const on = stream.on.bind(stream);
  stream.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data") calls.dataListeners += 1;
    return on(event, listener);
  }) as typeof stream.on;

  return { stream, calls };
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

const child = (id: string, status: string): TuiSpawn => ({
  id,
  agent: "helper",
  status,
  // A context every child carries, the way the core fills it on every handle.
  prompt: `work on ${id}`,
});

const mount = (spawns: TuiSpawn[]) => {
  const { stream: stdin, calls } = spiedStdin();
  // Snapshot before the app exists: ink adds no listeners of its own, so
  // anything that moves these counters afterwards is the tap's doing.
  const before = { ...calls };
  const { stream: stdout, chunks } = fakeStdout(20, 60);
  // Every prompt the app hands to its owner, so a chunk that made the round trip
  // through the tap can be told apart from one only the tap saw.
  const submitted: string[] = [];
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
      onSubmit={(prompt) => submitted.push(prompt)}
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
    calls,
    before,
    submitted,
    view: () => frameOf(chunks),
    // 1-based terminal row of the painted line that mentions `id`. Read off the
    // frame instead of recomputing the chrome arithmetic, the way the hover spec
    // does: a test that hard-codes the layout would go green the day the layout
    // moves and the report lands somewhere else.
    rowOf: (id: string): number => {
      const rows = frameOf(chunks).split("\n");
      const index = rows.findIndex((line) => line.includes(id));
      if (index === -1) throw new Error(`no row paints ${id}:\n${rows.join("\n")}`);
      return index + 1;
    },
    // The `read` installed on the stream right now, read at call time.
    read: () => (stdin as unknown as { read: unknown }).read,
    unmount: () => instance.unmount(),
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Bare motion, what `?1003h` sends: no button pressed, nothing held.
const move = (row: number, col = 3) => `\u001b[<35;${col};${row}m`;
// Glyph the highlight swaps the separator for, so the row reads as the one a
// click would act on.
const HOVER_GLYPH = "›";

describe("the stdin tap", () => {
  it("reads stdin without pausing it or listening for data", async () => {
    const app = mount([child("aaa", "running")]);
    await settle();

    // The baseline is the stream as it stood before the app existed. Ink adds
    // none of its own (it reads through `read`; it does not pause, resume or
    // listen for "data"), so any difference is the tap's doing. Measuring after
    // the mount would count a listener installed on the way up as part of the
    // furniture, which is exactly the mistake this test exists to catch.
    const before = app.before;

    // A report has to reach the tap for the assertions below to mean anything,
    // and the highlight is the proof that it did.
    app.stdin.write(move(app.rowOf("aaa")));
    await settle();
    const frame = app.view();
    const after = { ...app.calls };
    app.unmount();

    // Positive anchor first: if this line goes red the tap never saw the report,
    // and "nothing was paused" would be true for exactly the wrong reason.
    expect(frame).toContain(HOVER_GLYPH);
    expect(after.pause - before.pause).toBe(0);
    expect(after.resume - before.resume).toBe(0);
    expect(after.dataListeners - before.dataListeners).toBe(0);
  });

  it("hands the chunk back intact, so ink still reads what the tap parsed", async () => {
    // The tap parses a copy and returns the chunk it read; ink is the reader that
    // goes on to consume it. The pair is the point: a report the tap acted on (the
    // highlight) and a keystroke that only ink can turn into input (typing "x"
    // repaints the draft, Enter submits it). A tap that swallowed the chunk would
    // highlight the row and lose the key; one that returned a mangled copy would
    // lose both.
    const app = mount([child("aaa", "running")]);
    await settle();

    app.stdin.write(move(app.rowOf("aaa")));
    await settle();
    const hovered = app.view();
    // One key per chunk, the way promptWiring.spec types: the parser resolves an
    // escape as soon as it is complete, and a chunk carrying two keys is a flow
    // the terminal never produces.
    app.stdin.write("x");
    await settle();
    const typed = app.view();
    app.stdin.write("\r");
    await settle();
    const submitted = [...app.submitted];
    app.unmount();

    expect(hovered).toContain(HOVER_GLYPH);
    // The keystroke only reached the draft if ink parsed the chunk and the send
    // is the second half of the same claim: Enter is ink's key, not the tap's.
    // Matched with the prompt in front so this does not pass on the bare > of
    // an empty box.
    expect(typed).toContain("> x");
    expect(submitted).toEqual(["x"]);
  });
  it("restores the read it wrapped when it unmounts", async () => {
    const app = mount([child("aaa", "running")]);
    await settle();

    // Ink installs its own binding in front of `read` during setup and the tap
    // wraps that one, so the two identities differ while the app is mounted. A
    // cleanup that forgets the assignment leaves the tap closed over a dead
    // render in place for good.
    const wrapped = app.read();
    app.unmount();
    const restored = app.read();

    expect(wrapped).not.toBe(restored);
  });
});
