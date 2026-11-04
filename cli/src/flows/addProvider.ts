import type { IHarness } from "@racso/core";
// Every question goes through the UI: the flow decides what to ask and how to
// read the answer, the renderer decides how to ask it. None of them reads
// stdin here, because the TUI owns that stream and a second reader would
// starve Ink and paint a prompt outside the frame.
import type { UiAdapter } from "@/ui/UiAdapter";

// Narrow view of the harness the provider flows need, so first-run setup can
// reuse them straight on top of `Config`.
type ProviderPrimitives = {
  listProviders: () => string[];
  listProviderDetails: IHarness["listProviderDetails"];
  configureProvider: IHarness["configureProvider"];
  removeProvider: (id: string) => boolean;
};

export type ProviderTarget = ProviderPrimitives;

// Interactive flow to register a provider instance. Core only receives the
// resolved values: the CLI owns every prompt.
export const addProvider = async (
 ui: UiAdapter,
  harness: ProviderTarget,
  types: readonly string[] = [],
): Promise<{ id: string; changedDefault: boolean } | undefined> => {
  const available = types.length ? [...types] : ["openai"];

  // Every step aborts on a cancellation, and nothing reaches the harness until
// the last answer is in: a half-configured provider would leave the next run
// booting something nobody finished describing.
const rawId = await ui.promptText({ message: "Provider id (e.g. cheap, openrouter):" });
if (rawId === undefined) return undefined;

const id = rawId.trim().toLowerCase().replace(/\s+/g, "-");
if (!id) throw new Error("Provider id is required");

if (harness.listProviders().includes(id)) {
const overwrite = await ui.confirm({
message: `Provider "${id}" exists. Overwrite?`,
defaultAnswer: false,
});
if (overwrite !== true) return undefined;
}

const type =
available.length === 1
? available[0]
: await ui.select({
message: "Backend type:",
options: available.map((option) => ({ id: option, label: option })),
});
if (!type) return undefined;

  const rawUrl = await ui.promptText({ message: `[${id}] Base URL:` });
if (rawUrl === undefined) return undefined;

const url = rawUrl.trim();
if (!url) throw new Error("Base URL is required");

// The key is secret: the renderer masks it, because the screen it paints is a
// scrollback the user can copy.
const rawKey = await ui.promptText({ message: `[${id}] API key:`, secret: true });
if (rawKey === undefined) return undefined;

const apikey = rawKey.trim();
if (!apikey) throw new Error("API key is required");

// The model is the last answer that can be left empty, so the hint names
// both ways out: enter on an empty field takes the provider default, and esc
// on an empty field cancels the flow. Esc on a field that has text only
// clears it, so a typo here costs one keystroke and never the id, the type,
// the URL or the key already typed.
const rawModel = await ui.promptText({
message: `[${id}] Preferred model (optional):`,
hint: "leave it empty for the provider default",
});
if (rawModel === undefined) return undefined;

const model = rawModel.trim();

const makeDefault = await ui.confirm({
message: "Use as default provider?",
defaultAnswer: true,
});
if (makeDefault === undefined) return undefined;

harness.configureProvider(
    id,
    { type, url, apikey, ...(model ? { model } : {}) },
    { makeDefault },
  );

  return { id, changedDefault: makeDefault };
};
