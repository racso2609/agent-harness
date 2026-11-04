import { PassThrough } from "node:stream";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type TuiState } from "../../src/ui/tui/App";
import { resolveTheme } from "../../src/ui/tui/theme";

// The text and confirm questions used to read stdin, which the TUI cannot
// afford: Ink owns the stream, so a flow that asked directly painted outside
// the frame and lost keystrokes. These cases pin the new path: the adapter
// hands the question to the app and the answer comes back as a promise.

// The adapter tests only inspect the promises and the state, so the ink
// instance is stubbed: mounting the real one on a headless run would paint to
// a terminal that is not there. The render test below reaches the real
// `render` back through `importActual`, so the panel is painted for real.
vi.mock("ink", async (importOriginal) => {
const actual = await importOriginal<typeof import("ink")>();

return { ...actual, render: () => ({ rerender: () => {}, unmount: () => {} }) };
});

const realInk = await vi.importActual<typeof import("ink")>("ink");

const { TuiUiAdapter } = await import("../../src/ui/TuiUiAdapter");

afterEach(() => {
vi.restoreAllMocks();
});

describe("the TUI question", () => {
it("resolves the text the app collected and clears the panel", async () => {
const ui = new TuiUiAdapter();
const pending = ui.promptText({ message: "Provider id:" });

expect(ui.state.prompt).toMatchObject({ kind: "text", message: "Provider id:" });

ui.resolvePrompt("cheap");

expect(await pending).toBe("cheap");
expect(ui.state.prompt).toBeUndefined();
});

it("marks a secret question so the panel can mask it", async () => {
const ui = new TuiUiAdapter();
const pending = ui.promptText({ message: "API key:", secret: true });

expect(ui.state.prompt).toMatchObject({ kind: "text", secret: true });

ui.resolvePrompt("sk-secret");

expect(await pending).toBe("sk-secret");
});

it("resolves a confirmation to true, false or undefined", async () => {
for (const [answer, expected] of [
[true, true],
[false, false],
[undefined, undefined],
] as const) {
const ui = new TuiUiAdapter();
const pending = ui.confirm({ message: "Remove?", defaultAnswer: false });

expect(ui.state.prompt).toMatchObject({ kind: "confirm", defaultAnswer: false });

ui.resolvePrompt(answer);

expect(await pending).toBe(expected);
expect(ui.state.prompt).toBeUndefined();
}
});

it("refuses a second question instead of parking two promises on one slot", async () => {
const ui = new TuiUiAdapter();
const first = ui.promptText({ message: "first:" });

// Both kinds share the slot: a confirmation under a text question is a
// second question all the same, and answering it with the wrong shape would
// hand the flow an answer it never asked for.
expect(await ui.confirm({ message: "second?" })).toBeUndefined();
expect(await ui.promptText({ message: "third:" })).toBeUndefined();
// The refused ones never touched the panel of the first.
expect(ui.state.prompt).toMatchObject({ kind: "text", message: "first:" });

ui.resolvePrompt("answer");

expect(await first).toBe("answer");
});

it("answers a pending question with a cancellation when the app closes", async () => {
const ui = new TuiUiAdapter();
const text = ui.promptText({ message: "id:" });
const confirmation = ui.promptText({ message: "ignored:" });

ui.close();

expect(await text).toBeUndefined();
// The refused second one was already settled; the slot must not keep it.
expect(await confirmation).toBeUndefined();
expect(ui.state.prompt).toBeUndefined();
});

it("drops the pending question on a reset without leaving state behind", async () => {
const ui = new TuiUiAdapter();
const pending = ui.promptText({ message: "id:" });

ui.render({ type: "reset" });

expect(await pending).toBeUndefined();
expect(ui.state.prompt).toBeUndefined();
});

it("drops the pending picker when the app closes", async () => {
// A `/resume` with a picker open used to leave its promise hanging forever:
// the flow never returned and its caller stayed parked.
const ui = new TuiUiAdapter();
const pending = ui.select({ message: "which?", options: [{ id: "a", label: "a" }] });

ui.close();

expect(await pending).toBeUndefined();
expect(ui.state.selection).toBeUndefined();
});

it("drops the pending picker when the session changes", async () => {
const ui = new TuiUiAdapter();
const pending = ui.select({ message: "which?", options: [{ id: "a", label: "a" }] });

ui.render({ type: "conversation", entries: [{ role: "user", content: "hola" }] });

expect(await pending).toBeUndefined();
expect(ui.state.selection).toBeUndefined();
});

it("releases a pending question on a session with no conversation", async () => {
// Switching to a session that has nothing to show keeps the transcript on
// screen, and the early return that does it used to skip the release: the
// `await command.run(...)` of the loop stayed parked forever. The transcript
// is still the old one, and the promise still settles.
const ui = new TuiUiAdapter();

ui.render({ type: "conversation", entries: [{ role: "user", content: "de antes" }] });

const pending = ui.promptText({ message: "id:" });

ui.render({ type: "conversation", entries: [] });

expect(await pending).toBeUndefined();
expect(ui.state.prompt).toBeUndefined();
expect(ui.state.lines.map((line) => line.role)).toEqual(["user"]);
});
});

// Rendering a secret in the panel is the whole point of `secret`: the screen a
// terminal leaves behind is copyable, so the key must never reach it in clear.
describe("the question panel on screen", () => {
const fakeStdin = () => {
const stream = new PassThrough() as PassThrough & Record<string, unknown>;
stream.isTTY = true;
stream.setRawMode = () => {};
stream.ref = () => {};
stream.unref = () => {};
return stream;
};

const fakeStdout = () => {
const chunks: string[] = [];
const stream = new PassThrough() as PassThrough & Record<string, unknown>;
stream.isTTY = true;
stream.rows = 30;
stream.columns = 80;
const write = stream.write.bind(stream);
stream.write = ((chunk: string) => {
chunks.push(chunk);
return write(chunk);
}) as typeof stream.write;
return { stream, chunks };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// ESC and ENTER as a terminal sends them: the same bytes the app parses, so
// the key handling under test is the real one and not a handler called by
// hand.
const ESC = "\u001b";
const ENTER = "\r";

// Mounts the app for real and hands back what it answered plus the keys it
// was given. Every press waits a tick so React commits the repaint before the
// next one: the panel reads its own state, and two keys in the same frame
// would be answered from a stale `answer`.
const mount = async (state: Partial<TuiState>) => {
const stdin = fakeStdin();
const { stream: stdout, chunks } = fakeStdout();
const answers: (string | boolean | undefined)[] = [];
const full: TuiState = {
lines: [],
status: {},
spawns: [],
history: [],
theme: resolveTheme(),
expanded: new Set<number>(),
...state,
};
// Written without JSX so this stays a `.ts` spec: the app is mounted for
// real, but nothing here needs a template.
const instance = realInk.render(
createElement(App, {
state: full,
onSubmit: () => {},
onExit: () => {},
onDecision: () => {},
onPrompt: (answer: string | boolean | undefined) => answers.push(answer),
onToggle: () => {},
onToggleAll: () => {},
}),
{
stdin: stdin as unknown as NodeJS.ReadStream,
stdout: stdout as unknown as NodeJS.WriteStream,
exitOnCtrlC: false,
patchConsole: false,
},
);

await settle();

return {
answers,
output: () => chunks.join(""),
press: async (...keys: string[]) => {
for (const key of keys) {
stdin.write(key);
await settle();
}
},
unmount: () => instance.unmount(),
};
};

const paint = async (state: Partial<TuiState>, keys: string[] = []) => {
const app = await mount(state);

await app.press(...keys);

const output = app.output();
app.unmount();

return output;
};

it("masks a secret with one bullet per character", async () => {
const output = await paint(
{
prompt: { kind: "text", message: "API key:", secret: true },
},
["s", "k", "-"],
);

expect(output).toContain("API key:");
expect(output).toContain("•••");
expect(output).not.toContain("sk-");
});

it("paints the text of a public question as it is typed", async () => {
const output = await paint({ prompt: { kind: "text", message: "Provider id:" } }, ["c", "h"]);

expect(output).toContain("ch");
expect(output).toContain("[enter] accept");
});

it("says on the hint line that Esc clears before it cancels", async () => {
const output = await paint({ prompt: { kind: "text", message: "Provider id:" } });

expect(output).toContain("esc clear");
expect(output).toContain("esc again cancel");
});

it("clears the text on Esc and keeps the question open", async () => {
// A typo in an optional answer must not cost the values typed before it, so
// the first Esc only wipes the field. The proof that it did not resolve is
// the answer that comes after: the field is empty, so the "x" typed next is
// the whole answer, and the promise settles with it.
const app = await mount({ prompt: { kind: "text", message: "Preferred model:" } });

await app.press("b", "a", "d", ESC);

expect(app.answers).toEqual([]);

await app.press("x", ENTER);

expect(app.answers).toEqual(["x"]);
app.unmount();
});

it("cancels a text question on Esc when the field is empty", async () => {
const app = await mount({ prompt: { kind: "text", message: "Provider id:" } });

await app.press(ESC);

expect(app.answers).toEqual([undefined]);
app.unmount();
});

it("cancels a text question on a second Esc, once the field is empty", async () => {
const app = await mount({ prompt: { kind: "text", message: "Provider id:" } });

await app.press("a", "b", ESC);

expect(app.answers).toEqual([]);

await app.press(ESC);

expect(app.answers).toEqual([undefined]);
app.unmount();
});

it("answers a confirmation with the key itself", async () => {
for (const [keys, expected] of [
[["y"], true],
[["n"], false],
] as const) {
const app = await mount({
prompt: { kind: "confirm", message: "Remove?", defaultAnswer: false },
});

await app.press(...keys);

expect(app.answers).toEqual([expected]);
app.unmount();
}
});

it("answers a confirmation with the default on enter and cancels on Esc", async () => {
const accepted = await mount({
prompt: { kind: "confirm", message: "Use as default?", defaultAnswer: true },
});

await accepted.press(ENTER);

expect(accepted.answers).toEqual([true]);
accepted.unmount();

const cancelled = await mount({
prompt: { kind: "confirm", message: "Use as default?", defaultAnswer: true },
});

await cancelled.press(ESC);

// A confirmation has no text to lose, so Esc is the cancel straight away.
expect(cancelled.answers).toEqual([undefined]);
cancelled.unmount();
});

it("hints the keys of a confirmation and never shows the question as text", async () => {
const output = await paint({
prompt: { kind: "confirm", message: "Remove provider?", defaultAnswer: false },
});

expect(output).toContain("Remove provider?");
expect(output).toContain("[y] yes");
expect(output).toContain("[n] no");
});
});
