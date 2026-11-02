// Width-aware layout for markdown blocks.
//
// Markdown has no idea how wide the terminal is, so a table with many columns
// or a long line would push the pane out of shape. These helpers compute what
// fits and cut cleanly, keeping the rules pure and testable.

// Minimum width a column may keep before it gets truncated.
export const MIN_COLUMN_WIDTH = 3;

export interface FitColumn {
  width: number;
  // True when the column had to be narrowed.
  truncated: boolean;
}

// Shrinks the widest columns first until the total fits the available width.
// Every column keeps at least MIN_COLUMN_WIDTH and one character of padding
// per side, plus the separators, so the grid stays readable.
export const fitColumns = (natural: number[], available: number): FitColumn[] => {
  if (!natural.length) return [];

  // Cells are rendered as "│ " + cell + " │ ", so the fixed cost is 3 per column
  // plus one closing separator.
  const separators = 3 * natural.length + 1;
  const budget = Math.max(MIN_COLUMN_WIDTH * natural.length, available - separators);

  const widths = natural.map((width) => Math.max(MIN_COLUMN_WIDTH, width));

  let total = widths.reduce((sum, width) => sum + width, 0);

  while (total > budget) {
    // Narrow the widest column that is still above the floor.
    let target = -1;

    for (let index = 0; index < widths.length; index++) {
      if (widths[index]! <= MIN_COLUMN_WIDTH) continue;
      if (target === -1 || widths[index]! > widths[target]!) target = index;
    }

    if (target === -1) break;

    widths[target] = widths[target]! - 1;
    total--;
  }

  return widths.map((width, index) => ({
    width,
    truncated: width < natural[index]!,
  }));
};

// Cuts a cell to fit its column, marking the cut with an ellipsis character.
export const truncateCell = (text: string, width: number): string => {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);

  return `${text.slice(0, width - 1)}…`;
};

// Wraps text to the given width on word boundaries when possible.
export const wrapText = (text: string, width: number): string[] => {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";

    for (const word of paragraph.split(" ")) {
      if (!word) continue;

      if (!current) {
        current = word;
        continue;
      }

      if (`${current} ${word}`.length <= safeWidth) {
        current = `${current} ${word}`;
        continue;
      }

      lines.push(current);
      current = word;
    }

    // A single word longer than the width is hard-split.
    while (current.length > safeWidth) {
      lines.push(current.slice(0, safeWidth));
      current = current.slice(safeWidth);
    }

    lines.push(current);
  }

  return lines;
};
