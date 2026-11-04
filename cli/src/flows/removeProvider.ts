import type { IHarness } from "@racso/core";
// Both questions go through the UI, for the same reason as addProvider: only
// the renderer that owns the input stream may ask the user anything.
import type { UiAdapter } from "@/ui/UiAdapter";

// Interactive flow to drop a provider instance. Refuses to remove the last
// remaining one so the harness always has something to boot from.
export const removeProvider = async (
 ui: UiAdapter,
  harness: IHarness,
  id?: string,
): Promise<string | undefined> => {
  const details = harness.listProviderDetails();
  if (!details.length) return undefined;

  const label = (provider: (typeof details)[number]) =>
    `${provider.id} (${provider.type})${provider.isDefault ? " *default" : ""}`;

  const labels = details.map(label);
// The option id is the provider id, so the label is only what the user reads
// and an id typed on the command line is accepted as is.
const target =
id?.trim() ||
(await ui.select({
message: "Select the provider to remove:",
options: details.map((provider) => ({ id: provider.id, label: label(provider) })),
}));
if (!target) return undefined;

  // Accept either the raw id or the labelled menu entry.
  const selected =
    details.find((provider) => provider.id === target) ?? details[labels.indexOf(target)];
  if (!selected) return undefined;

  if (details.length === 1) {
    throw new Error("Cannot remove the last configured provider");
  }

  // Deleting cannot be undone, so the default is "no": a stray Enter must not
// choose it.
const answer = await ui.confirm({
message: `Remove provider "${selected.id}"? This cannot be undone.`,
defaultAnswer: false,
});
if (answer !== true) return undefined;

return harness.removeProvider(selected.id) ? selected.id : undefined;
};
