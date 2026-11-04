import type { Config } from "@racso/core";
import { SUPPORTED_PROVIDERS } from "@racso/core";
import { askHidden, input, select } from "@/terminal/stdin";
import type { UiAdapter } from "@/ui/UiAdapter";
import { addProvider } from "./addProvider";

// First-run setup runs before Ink is mounted, so there is no renderer to ask
// through: this adapter reads stdin itself, with the same prompts the line
// renderer uses, because at that point it is the only reader of the terminal.
// It is a reason and not an exception: once the TUI is mounted, every
// question has to go through it, since it owns the stream.
const stdinUi: UiAdapter = {
render: () => {},
promptApproval: async () => "deny",
select: async (request) => {
if (!request.options.length) return undefined;

const chosen = await select(
request.message,
request.options.map((option) => option.label),
);

return request.options.find((option) => option.label === chosen)?.id;
},
// Same contract as the line renderer: an empty answer is a cancellation, and
// what to do with surrounding spaces stays with the flow.
promptText: async (request) => {
const answer = request.secret ? await askHidden(`${request.message} `) : await input(request.message);

return answer.length ? answer : undefined;
},
// Enter takes the default the flow asked for; anything unrecognised cancels
// instead of guessing an answer the user never gave.
confirm: async (request) => {
const fallback = request.defaultAnswer ?? false;
const answer = (await input(`${request.message} ${fallback ? "[Y/n]" : "[y/N]"} `))
.trim()
.toLowerCase();

if (!answer) return fallback;
if (/^y(es)?$/.test(answer)) return true;
if (/^n(o)?$/.test(answer)) return false;

return undefined;
},
renderImage: async () => {},
close: () => {},
};

// Interactive first-run setup. Prompts for the provider id, base URL, key and
// model, then persists the result through the non-interactive Config API.
// The backend type is asked by addProvider only when more than one exists.
export const startSetup = async (config: Config): Promise<void> => {
await addProvider(stdinUi, config, [...SUPPORTED_PROVIDERS]);
config.writeConfig();
};
