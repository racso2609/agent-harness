import type { IHarness } from "@racso/core";
import { input, select } from "@/terminal/stdin";

// Interactive flow to drop a provider instance. Refuses to remove the last
// remaining one so the harness always has something to boot from.
export const removeProvider = async (
  harness: IHarness,
  id?: string,
): Promise<string | undefined> => {
  const details = harness.listProviderDetails();
  if (!details.length) return undefined;

  const label = (provider: (typeof details)[number]) =>
    `${provider.id} (${provider.type})${provider.isDefault ? " *default" : ""}`;

  const labels = details.map(label);
  const target =
    id?.trim() || (await select("Select the provider to remove:", labels));
  if (!target) return undefined;

  // Accept either the raw id or the labelled menu entry.
  const selected =
    details.find((provider) => provider.id === target) ??
    details[labels.indexOf(target)];
  if (!selected) return undefined;

  if (details.length === 1) {
    throw new Error("Cannot remove the last configured provider");
  }

  const answer = (
    await input(`Remove provider "${selected.id}"? This cannot be undone [y/N]: `)
  )
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") return undefined;

  return harness.removeProvider(selected.id) ? selected.id : undefined;
};
