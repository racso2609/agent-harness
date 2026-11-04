import type { CommandOption } from "@/commands/CommandRepository";
import {
COMMAND_KEYS,
menuItems,
menuQueryFor,
menuRows,
menuSelectAt,
type MenuRows,
type MenuState,
} from "@/terminal/commandMenu";
import { MENU_VISIBLE_ROWS } from "./viewport";

// Re-exported rather than redefined: the line prompt asks the same question
// from terminal/commandMenu, and two copies of "when is the dropdown open"
// is exactly how the two renderers drifted apart before.
export { menuQueryFor };

// What the dropdown shows for a query. The rows come from the shared model, so
// the ink renderer and the line renderer cannot drift on which commands fit.
export const menuView = (
commands: CommandOption[],
query: string,
selected: number,
maxVisible = MENU_VISIBLE_ROWS,
): { state: MenuState<CommandOption>; rows: MenuRows<CommandOption> } => {
const items = menuItems(query, commands, COMMAND_KEYS);
// Clamped: the list shrinks under the cursor as the query grows.
const state = menuSelectAt({ items, query, selected }, selected);

return { state, rows: menuRows(state, maxVisible) };
};

// What Tab completes to: the command plus the space that starts its arguments,
// so the user keeps typing instead of pressing another key.
export const menuCompletion = (command: CommandOption): string => `/${command.name} `;

// What Enter runs with the dropdown open. The arguments already typed belong to
// a name the user did not choose, so only the command is sent.
export const menuCommandLine = (command: CommandOption): string => `/${command.name}`;
