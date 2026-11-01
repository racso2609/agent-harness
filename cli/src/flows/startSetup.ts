import { Config, SUPPORTED_PROVIDERS } from "@racso/core";
import { input, select } from "@/terminal/stdin";

// Interactive first-run setup. Prompts for provider/URL/key and persists the
// result through the non-interactive Config API.
export const startSetup = async (config: Config): Promise<void> => {
  const provider = await select(
    "Select the provider to configure:",
    [...SUPPORTED_PROVIDERS],
  );

  const url = (await input(`[${provider}] Base URL: `)).trim();
  if (!url) throw new Error("Base URL is required");

  const apikey = (await input(`[${provider}] API key: `)).trim();
  if (!apikey) throw new Error("API key is required");

  const model = (await input("Default model (optional): ")).trim();

  config.configureProvider(
    provider,
    { url, apikey },
    { makeDefault: true, model: model || undefined },
  );
  config.writeConfig();
};
