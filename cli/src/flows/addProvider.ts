import type { IHarness } from "@racso/core";
import { input, select } from "@/terminal/stdin";

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
  harness: ProviderTarget,
  types: readonly string[] = [],
): Promise<{ id: string; changedDefault: boolean } | undefined> => {
  const available = types.length ? [...types] : ["openai"];

  const id = (await input("Provider id (e.g. cheap, openrouter): "))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!id) throw new Error("Provider id is required");

  if (harness.listProviders().includes(id)) {
    const overwrite = (await input(`Provider "${id}" exists. Overwrite? [y/N]: `))
      .trim()
      .toLowerCase();
    if (overwrite !== "y" && overwrite !== "yes") return undefined;
  }

  const type = available.length === 1 ? available[0] : await select("Backend type:", available);

  const url = (await input(`[${id}] Base URL: `)).trim();
  if (!url) throw new Error("Base URL is required");

  const apikey = (await input(`[${id}] API key: `)).trim();
  if (!apikey) throw new Error("API key is required");

  const model = (await input(`[${id}] Preferred model (optional): `)).trim();

  const makeDefault =
    (await input("Use as default provider? [Y/n]: ")).trim().toLowerCase() !== "n";

  harness.configureProvider(
    id,
    { type, url, apikey, ...(model ? { model } : {}) },
    { makeDefault },
  );

  return { id, changedDefault: makeDefault };
};
