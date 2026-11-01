import type { Config } from "@racso/core";
import { SUPPORTED_PROVIDERS } from "@racso/core";
import { addProvider } from "./addProvider";

// Interactive first-run setup. Prompts for the provider id, base URL, key and
// model, then persists the result through the non-interactive Config API.
// The backend type is asked by addProvider only when more than one exists.
export const startSetup = async (config: Config): Promise<void> => {
  await addProvider(config, [...SUPPORTED_PROVIDERS]);
  config.writeConfig();
};
