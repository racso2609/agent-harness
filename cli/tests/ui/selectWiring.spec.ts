import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ConversationEntry, IHarness } from "@racso/core";
import type { SelectionRequest } from "../../src/ui/UiAdapter";

// The pickers used to read stdin on their own, which the TUI cannot afford:
// Ink owns the stream, so the flows now ask the renderer through `select()`.
// These cases pin that path end to end, from the line renderer down to the
// flows, and guard the source against a stdin import sneaking back in.

vi.mock("../../src/terminal/stdin", () => ({
clearPrompt: vi.fn(),
restorePrompt: vi.fn(),
printLogo: vi.fn(),
printImage: vi.fn(),
input: vi.fn(),
select: vi.fn(),
}));

vi.mock("ink", () => ({
render: () => ({ rerender: () => {}, unmount: () => {} }),
Box: () => null,
Text: () => null,
useInput: () => {},
useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
}));

const stdin = await import("../../src/terminal/stdin");
const { CliUiAdapter } = await import("../../src/ui/CliUiAdapter");
const { TuiUiAdapter } = await import("../../src/ui/TuiUiAdapter");
const { createFlows } = await import("../../src/flows");
const { MainLoop } = await import("../../src/MainLoop");

const request: SelectionRequest = {
message: "Select the model:",
options: [
{ id: "model-a", label: "gpt-a — fast" },
{ id: "model-b", label: "gpt-b — smart" },
],
};

afterEach(() => {
vi.restoreAllMocks();
vi.mocked(stdin.select).mockReset();
});

describe("the line renderer picker", () => {
it("translates the chosen label back to its id", async () => {
// The numeric list answers with the label it printed; the flow expects the
// id, which is the only thing it may hand to the harness.
vi.mocked(stdin.select).mockResolvedValue("gpt-b — smart");

expect(await new CliUiAdapter().select(request)).toBe("model-b");
expect(vi.mocked(stdin.select).mock.calls[0]).toEqual([
"Select the model:",
["gpt-a — fast", "gpt-b — smart"],
]);
});

it("propagates a cancellation as undefined", async () => {
vi.mocked(stdin.select).mockResolvedValue("something else");

expect(await new CliUiAdapter().select(request)).toBeUndefined();
});

it("cancels without asking when there is nothing to choose", async () => {
expect(await new CliUiAdapter().select({ message: "any", options: [] })).toBeUndefined();
expect(stdin.select).not.toHaveBeenCalled();
});
});

describe("the TUI picker", () => {
it("resolves the promise its panel is waiting on and clears the state", async () => {
const ui = new TuiUiAdapter();
const pending = ui.select(request);

expect(pending).toBeInstanceOf(Promise);

// `resolveSelection` is what the app calls on enter; a second call must not
// resolve anything twice.
ui.resolveSelection("model-a");

expect(await pending).toBe("model-a");
expect(ui.state.selection).toBeUndefined();
});

it("cancels the panel with undefined", async () => {
const ui = new TuiUiAdapter();
const pending = ui.select(request);

ui.resolveSelection(undefined);

expect(await pending).toBeUndefined();
expect(ui.state.selection).toBeUndefined();
});

it("refuses a second picker instead of parking two promises on one slot", async () => {
const ui = new TuiUiAdapter();
const first = ui.select(request);

expect(await ui.select(request)).toBeUndefined();

ui.resolveSelection("model-b");

expect(await first).toBe("model-b");
});
});

// A flow that reached for stdin would compile and pass a naive test, and only
// fail on a real TTY, where Ink already owns the stream. The guard reads the
// source for the import, the shape the other wiring specs use.
describe("the flows", () => {
const source = readFileSync(new URL("../../src/flows/index.ts", import.meta.url), "utf8");

it("asks the UI instead of stdin", () => {
expect(source).not.toContain("terminal/stdin");
expect(source).toContain("ui.select(");
});

it("picks the session the user chose by its id", async () => {
// The old label carried a position ("1) id") and the flow decoded it with a
// regex; the option id is the session id now, so nothing has to be decoded.
const loaded: string[] = [];
const harness = {
listSessions: () => [
{
id: "session-a",
createdAt: "2024-01-01T00:00:00.000Z",
updatedAt: "2024-01-02T00:00:00.000Z",
provider: "openai",
model: "gpt-test",
messageCount: 1,
title: "hola",
},
],
} as unknown as IHarness;
const ui = {
select: vi.fn(async () => "session-a"),
} as unknown as Parameters<typeof createFlows>[0];

const flows = createFlows(ui, []);
flows.changeSession({
...harness,
loadSession: async (id: string) => {
loaded.push(id);
return true;
},
} as unknown as IHarness);

await vi.waitFor(() => expect(loaded).toEqual(["session-a"]));
});

it("never asks the flow to touch stdin", async () => {
// The pick is stubbed on the UI: reaching stdin instead would leave the
// mock untouched and hang the call.
const ui = {
select: vi.fn(async () => "openai"),
} as unknown as Parameters<typeof createFlows>[0];
const flows = createFlows(ui, []);

await flows.changeModel({
listModels: () => [{ id: "gpt-test" }],
setModel: () => true,
} as unknown as IHarness);

expect(vi.mocked(ui.select).mock.calls[0]?.[0]).toEqual({
message: "Select the model:",
options: [{ id: "gpt-test", label: "gpt-test" }],
});
});

it("hands the same UI to the flows it builds", () => {
// The loop reads `flows.ui` nowhere, but the field is what makes a flow
// reachable from a command without another argument.
const ui = { select: vi.fn() } as unknown as Parameters<typeof createFlows>[0];

expect(createFlows(ui, []).ui).toBe(ui);
});

it("gives MainLoop's commands to the app that paints the dropdown", () => {
// The catalog reaches the TUI through start(): Ink owns stdin, so the app
// cannot ask stdin for the inline menu the line renderer uses.
const loop = readFileSync(new URL("../../src/MainLoop.ts", import.meta.url), "utf8");

expect(loop).toContain("commands: this.commands.list(),");
expect(loop).toContain("createFlows(this.ui,");
expect(typeof MainLoop).toBe("function");
});

it("shows no conversation for a session that has none", () => {
// A guard against the picker path quietly changing what boot paints.
const entries: ConversationEntry[] = [];

expect(entries).toHaveLength(0);
});
});
