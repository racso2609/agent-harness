// Collapse rules for noisy entries (reasoning and tool output).
//
// While a turn is running these entries are visible so the user has a sign of
// life, but only the tail: a long reasoning dump or a chatty command must not
// push the answer off screen. Expanding an entry shows it in full.

export type CollapsibleRole = "reasoning" | "tool";

// How many trailing lines a collapsed-window entry shows.
export const PREVIEW_LINES = 6;

// Width used to estimate how many visual lines a chunk of text occupies. The
// TUI cannot know the real terminal width here, so the caller passes it.
export const estimateLines = (text: string, width: number): string[] => {
  if (!text) return [];

  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      lines.push("");
      continue;
    }

    for (let i = 0; i < raw.length; i += safeWidth) {
      lines.push(raw.slice(i, i + safeWidth));
    }
  }

  return lines;
};

// Keeps only the last `limit` visual lines, marking that content was cut.
// The marker is what tells the user the entry is collapsed and expandable.
export const tail = (lines: string[], limit = PREVIEW_LINES): string => {
  if (lines.length <= limit) return lines.join("\n");

  return ["…", ...lines.slice(-limit)].join("\n");
};

export interface CollapseInput {
  role: CollapsibleRole;
  // Full text of the entry (already rendered to plain text).
  text: string;
  // Terminal width used to wrap; pass Infinity to avoid wrapping.
  width: number;
  // Turn in flight: entries are previewed instead of hidden.
  running: boolean;
  // The user opened this entry explicitly.
  expanded: boolean;
  // Tool output that failed is never hidden behind a keypress.
  failed?: boolean;
}

export interface CollapseResult {
  shown: string;
  hidden: boolean;
  // Human-readable note for the collapsed header, e.g. "412 car." or "8 líneas".
  summary: string;
}

// Decides what of an entry is visible.
export const collapse = (input: CollapseInput): CollapseResult => {
  const lines = estimateLines(input.text, input.width);
  const summary = lines.length === 1 ? `${input.text.length} car.` : `${lines.length} líneas`;

  if (input.expanded || input.failed) {
    return { shown: lines.join("\n"), hidden: false, summary };
  }

  if (input.running) {
    return { shown: tail(lines), hidden: lines.length > PREVIEW_LINES, summary };
  }

  // Idle: a settled entry collapses to its header unless it is short enough to
  // be worth showing.
  if (lines.length <= PREVIEW_LINES) {
    return { shown: lines.join("\n"), hidden: false, summary };
  }

  return { shown: "", hidden: true, summary };
};
