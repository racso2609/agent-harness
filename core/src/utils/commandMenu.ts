import type { CommandOption } from "@/commands/CommandRepository";

// Filters by name or alias prefix. Empty query returns every command.
export const filterCommands = (
  commands: CommandOption[],
  query: string,
): CommandOption[] => {
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
export const moveSelection = (
  selected: number,
  delta: number,
  length: number,
): number => {
  if (length <= 0) return 0;
  return (clampSelection(selected, length) + delta + length) % length;
};

// Returns the slice of options visible around the selection.
export const visibleCommands = (
  commands: CommandOption[],
  selected: number,
  maxVisible: number,
): CommandOption[] => {
  if (commands.length <= maxVisible) return commands;

  const half = Math.floor(maxVisible / 2);
  const start = Math.min(
    Math.max(selected - half, 0),
    commands.length - maxVisible,
  );

  return commands.slice(start, start + maxVisible);
};
