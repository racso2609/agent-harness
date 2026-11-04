import type { Config } from "@racso/core";
import { SUPPORTED_PROVIDERS } from "@racso/core";
import { select } from "@/terminal/stdin";
import type { UiAdapter } from "@/ui/UiAdapter";
import { addProvider } from "./addProvider";

// First-run setup runs before Ink is mounted, so there is no renderer to ask
// the picker through: it answers with the numeric list of stdin, the same one
// the line renderer uses, which is the only reader of the terminal at that
// point.
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
