import type { IHarness } from "@racso/core";
import type { UiAdapter } from "@/ui/UiAdapter";
import { addProvider as addProviderFlow } from "./addProvider";
import { removeProvider as removeProviderFlow } from "./removeProvider";

// Interactive flows layered on top of the non-interactive harness primitives.
// Each flow owns the prompting; core only receives the resolved choice.

export interface Flows {
// Renderer used for the pickers. A flow never touches the terminal itself,
// because the renderer owns the input stream and a second reader would fight
// it (Ink pauses stdin, so a raw listener would starve the TUI).
ui: UiAdapter;
changeProvider(harness: IHarness, name?: string): Promise<boolean>;
addProvider(harness: IHarness): Promise<boolean>;
removeProvider(harness: IHarness, id?: string): Promise<boolean>;
changeModel(harness: IHarness, model?: string): Promise<boolean>;
changeAgent(harness: IHarness, name?: string): Promise<boolean>;
changeSession(harness: IHarness, target?: string): Promise<boolean>;
}

export const createFlows = (ui: UiAdapter, types: string[] = []): Flows => {
const pick = (message: string, options: string[]): Promise<string | undefined> =>
ui.select({
message,
options: options.map((option) => ({ id: option, label: option })),
});

return {
ui,

async changeProvider(harness, name) {
const selected = name ?? (await pick("Select the provider:", harness.listProviders()));
if (!selected) return false;
return harness.setProvider(selected);
},

async addProvider(harness) {
const created = await addProviderFlow(ui, harness, types);
return Boolean(created);
},

async removeProvider(harness, id) {
const removed = await removeProviderFlow(ui, harness, id);
return Boolean(removed);
},

async changeModel(harness, model) {
const selected =
model ??
(await pick(
"Select the model:",
harness.listModels().map((m) => m.id),
));
if (!selected) return false;
return harness.setModel(selected);
},

async changeAgent(harness, name) {
const selected =
name ??
(await pick(
"Select the agent:",
harness.listAgents().map((a) => a.id),
));
if (!selected) return false;
return harness.setAgent(selected);
},

async changeSession(harness, target) {
const sessions = harness.listSessions();
if (!sessions.length) return false;

// The option id is the session id itself, so nothing has to be decoded on
// the way back: the old "N) id — title" label forced a regex to recover the
// position in a list that the harness can order differently between calls.
const resolved =
target ??
(await ui.select({
message: "Select the session:",
options: sessions.map((session) => ({
id: session.id,
label: session.title ? `${session.id} — ${session.title}` : session.id,
})),
}));

if (!resolved) return false;

return harness.loadSession(resolved);
},
};
};
