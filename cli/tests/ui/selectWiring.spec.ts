import { afterEach, describe, expect, it, vi } from "vitest";
import type {
ConversationEntry,
IHarness,
SpawnEventListener,
SpawnHandle,
} from "@racso/core";
import type { TuiState } from "../../src/ui/tui/App";
import type { SelectionRequest, UiEvent } from "../../src/ui/UiAdapter";

// The pickers used to read stdin on their own, which the TUI cannot afford:
// Ink owns the stream, so the flows now ask the renderer through `select()`.
// These cases pin that path end to end, from the line renderer down to the
// flows, by mounting the real objects: a source guard passes as soon as the
// string it looks for appears anywhere in a file, while the wiring it was
// meant to protect can be broken underneath it.

vi.mock("../../src/terminal/stdin", () => ({
clearPrompt: vi.fn(),
restorePrompt: vi.fn(),
printLogo: vi.fn(),
printImage: vi.fn(),
input: vi.fn(),
select: vi.fn(),
}));

// The loop runs the interactive setup on a machine with no usable config, and
// that flow reads stdin: the config built below has no providers, so
// `needsSetup()` is true by construction and the flow is stubbed.
vi.mock("../../src/flows/startSetup", () => ({ startSetup: async () => {} }));

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
const { Config, SUPPORTED_PROVIDERS } = await import("@racso/core");

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

// A complete harness, not just the methods one case happens to call: the real
// loop boots against it (initialize, status, the spawn subscription), and a
// stub that lied about them would let the boot path under test go untested.
const fakeHarness = (options: { conversation?: ConversationEntry[] } = {}): IHarness => {
const listeners: SpawnEventListener[] = [];
// The session the harness is in: /resume has to be observable through status,
// which is how the loop notices a command switched sessions.
let sessionId = "session-new";

return {
initialize: async () => {},
ask: async () => ({ text: "done" }),
status: () => ({
sessionId,
provider: "openai",
model: "gpt-test",
usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
costUsd: 0,
contextTokens: 0,
contextUsage: 0,
autoCompact: true,
autoCompactThreshold: 60,
}),
listSessions: () => [
{
id: "session-old",
createdAt: "2024-01-01T00:00:00.000Z",
updatedAt: "2024-01-02T00:00:00.000Z",
provider: "openai",
model: "gpt-test",
messageCount: 2,
title: "hola",
},
],
resolveSession: () => undefined,
loadSession: async (id: string) => {
sessionId = id;
return true;
},
save: () => {},
conversation: () => options.conversation ?? [],
listProviders: () => [...SUPPORTED_PROVIDERS],
listProviderDetails: () => [],
configureProvider: () => {},
removeProvider: () => false,
setProvider: async () => false,
listModels: () => [],
setModel: () => false,
listAgents: () => [],
listSkills: () => [],
reloadSkills: () => [],
setAgent: async () => false,
approveWith: () => {},
spawn: () => ({}) as SpawnHandle,
pollSpawn: () => undefined,
listSpawns: () => [],
childHistory: () => [],
pendingSpawns: () => [],
onSpawnEvent: (listener) => {
listeners.push(listener);
return () => {};
},
waitSpawn: async () => undefined,
collectSpawns: async () => [],
compactSession: async () => false,
shutdown: () => {},
};
};

// The real adapter with the two bits a case has to see: what was rendered and
// what it holds on screen. Everything else is the shipping class.
class Probe extends TuiUiAdapter {
get view(): TuiState {
return this.state as TuiState;
}

get events(): UiEvent[] {
return this.seen;
}

// The picker behind the panel, so a case can open one the way a flow does.
get picker(): { resolveSelection(id: string | undefined): void } {
return this;
}

protected seen: UiEvent[] = [];

override render(event: UiEvent) {
this.seen.push(event);
super.render(event);
}
}

const sleep = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the loop to reach a state, so no case depends on how many
// microtasks a boot happens to take.
const until = async (done: () => boolean) => {
for (let attempt = 0; attempt < 500 && !done(); attempt += 1) await sleep(1);

expect(done()).toBe(true);
};

// Boots the real loop in TUI mode on the fake harness and parks it where the
// input box hands its prompts over, which is the only state a command can be
// typed into.
const boot = async (options: { conversation?: ConversationEntry[] } = {}) => {
const harness = fakeHarness(options);
// A hand-built config with no providers is the one shape that never prompts
// for setup, so it keeps a flow that reads stdin out of the run.
const config = new Config();
config.config.providers = {};
config.config.defaultProvider = undefined;

const loop = new MainLoop({ config, tui: true });
loop.harness = harness;
const ui = new Probe();
loop.ui = ui;

void loop.start();
await until(() => (loop as unknown as { isWaitingForPrompt(): boolean }).isWaitingForPrompt());

return { ui, loop };
};

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
// fail on a real TTY, where Ink already owns the stream. The cases below ask
// the real flow and the real loop, so the answer can only come from the UI.
describe("the flows", () => {
it("asks the UI instead of stdin", async () => {
const harness = fakeHarness();
const ui = {
select: vi.fn(async () => "session-old"),
} as unknown as Parameters<typeof createFlows>[0];

const changed = await createFlows(ui, []).changeSession(harness);

expect(changed).toBe(true);
// The picker is the UI's, asked once: the stdin picker would have been the
// one called, and this line renderer stub is what proves it was not.
expect(ui.select).toHaveBeenCalledTimes(1);
expect(stdin.select).not.toHaveBeenCalled();
expect(harness.status().sessionId).toBe("session-old");
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

it("gives MainLoop's commands to the app that paints the dropdown", async () => {
// The catalog reaches the TUI through start(): Ink owns stdin, so the app
// cannot ask stdin for the inline menu the line renderer uses. The real loop
// boots here, and the argument it hands the app is what gets checked.
const start = vi.spyOn(TuiUiAdapter.prototype, "start");

const { loop } = await boot();

const received = start.mock.calls[0]?.[0] as { commands?: unknown[] };

expect(received.commands).toEqual(loop.commands.list());
});

it("keeps the transcript but releases the picker on a session with no conversation", async () => {
// Two things at once, and they used to fight: an empty conversation must
// leave the transcript alone, and the picker it does not paint must not keep
// the flow of the session we left waiting forever. The transcript stays and
// the promise settles.
const { ui } = await boot({ conversation: [{ role: "user", content: "de antes" }] });
const pending = ui.select(request);

ui.render({ type: "conversation", entries: [] });

expect(ui.view.lines.map((line) => line.role)).toEqual(["user"]);
// The flow is told the picker was cancelled instead of being left parked.
expect(await pending).toBeUndefined();
expect(ui.view.selection).toBeUndefined();
});
});
