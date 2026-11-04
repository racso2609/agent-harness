import type { CommandOption } from "@/commands/CommandRepository";

// Filters by name or alias prefix. Empty query returns every command.
export const filterCommands = (commands: CommandOption[], query: string): CommandOption[] => {
const needle = query.trim().toLowerCase();
if (!needle) return commands;

return commands.filter((command) =>
[command.name, ...(command.aliases ?? [])].some((candidate) =>
candidate.toLowerCase().startsWith(needle),
),
);
};

// Keeps the selected index inside the available range.
export const clampSelection = (selected: number, length: number): number => {
if (length <= 0) return 0;
return Math.min(Math.max(selected, 0), length - 1);
};

// Moves the selection with wrap-around, like most command palettes.
export const moveSelection = (selected: number, delta: number, length: number): number => {
if (length <= 0) return 0;
return (clampSelection(selected, length) + delta + length) % length;
};

// Returns the slice of options visible around the selection.
export const visibleCommands = <T>(commands: T[], selected: number, maxVisible: number): T[] => {
if (commands.length <= maxVisible) return commands;

const half = Math.floor(maxVisible / 2);
const start = Math.min(Math.max(selected - half, 0), commands.length - maxVisible);

return commands.slice(start, start + maxVisible);
};

// One row of a picker. `hint` is the secondary text a renderer may append
// after the label, and is already styled as dim by whoever paints it.
export interface MenuEntry {
label: string;
hint?: string;
}

// A selectable list and what the user typed to narrow it. The same shape
// drives the "/" menu of the input box and the modal pickers, so both
// renderers (ink and lines) share one state machine instead of two.
export interface MenuState<T> {
items: T[];
query: string;
selected: number;
}

// The window of a list that is really painted, plus how many rows stay out of
// sight on each side: the renderer needs that to show "3/15".
export interface MenuRows<T> {
start: number;
rows: T[];
hiddenAbove: number;
hiddenBelow: number;
}

// What a command is matched by when the user types: its name and its aliases.
export const COMMAND_KEYS = (command: CommandOption): string[] => [
command.name,
...(command.aliases ?? []),
];

// Prefix filter over arbitrary items. The empty query hands back the very same
// array (not a copy) so a renderer can tell "nothing typed" from "filtered" by
// identity, and so a keystroke that clears the query costs no allocation.
export const menuItems = <T>(query: string, items: T[], keys: (item: T) => string[]): T[] => {
const needle = query.trim().toLowerCase();
if (!needle) return items;

return items.filter((item) =>
keys(item).some((candidate) => candidate.toLowerCase().startsWith(needle)),
);
};

// Moves the selection inside the already filtered list, wrapping at the ends
// so holding an arrow never dead-ends the menu.
export const menuMove = <T>(state: MenuState<T>, delta: number): MenuState<T> => ({
...state,
selected: moveSelection(state.selected, delta, state.items.length),
});

// Pins the selection to an index, clamped: a list that shrank under the
// cursor (a filter change, mostly) must not leave it pointing past the end.
export const menuSelectAt = <T>(state: MenuState<T>, index: number): MenuState<T> => ({
...state,
selected: clampSelection(index, state.items.length),
});

// The window around the selection. Reuses `visibleCommands` for the slice and
// only derives the bookkeeping the slice itself does not carry: keeping the
// arithmetic in one place is what keeps the "3/15" indicator honest with the
// rows painted next to it.
export const menuRows = <T>(state: MenuState<T>, maxVisible: number): MenuRows<T> => {
const limit = Math.max(1, Math.floor(maxVisible));
const selected = clampSelection(state.selected, state.items.length);
const rows = visibleCommands(state.items, selected, limit);

if (!rows.length) return { start: 0, rows, hiddenAbove: 0, hiddenBelow: 0 };

const start = state.items.indexOf(rows[0]!);

return {
start,
rows,
hiddenAbove: start,
hiddenBelow: state.items.length - start - rows.length,
};
};
