// Incremental markdown for streamed text.
//
// The model streams markdown in fragments, so the raw deltas show `**`, `#`
// and fences literally until the block closes. Instead of concatenating
// characters, chunks are accumulated and split into blocks: a block already
// terminated by a blank line is parsed with its final styling, while the block
// still being written is shown as plain text. Nothing flickers, and the last
// block simply gains its styling the moment it closes.

export type InlineSpan = {
text: string;
bold?: boolean;
italic?: boolean;
code?: boolean;
};

export type Alignment = "left" | "center" | "right";

export interface TableBlock {
  kind: "table";
  header: string[];
  align: Alignment[];
  rows: string[][];
}

export interface ListItem {
  // Nesting depth, 0 for a top-level item.
  depth: number;
  // Bullet or ordinal marker shown before the text.
  marker: string;
  spans: InlineSpan[];
}

export type Block =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "code"; language?: string; lines: string[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | TableBlock
  | { kind: "rule" };

export interface StreamDocument {
  // Blocks already closed by the stream; safe to style definitively.
  blocks: Block[];
  // The block still being written, rendered as plain text.
  open: string;
}

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
// A table row: pipe-separated cells. Leading/trailing pipes are optional.
const TABLE_ROW = /^\s*\|?(.*?)\|?\s*$/;
// The separator row that turns the previous line into a header.
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

// Splits a text range into styled spans for one line of markdown.
export const parseInline = (text: string): InlineSpan[] => {
  if (!text) return [];

  const spans: InlineSpan[] = [];
  // Order matters: code first so ** inside backticks stays literal.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)|(_[^_]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      spans.push({ text: text.slice(cursor, match.index) });
    }

    const raw = match[0];

    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), code: true });
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true });
    } else {
      spans.push({ text: raw.slice(1, -1), italic: true });
    }

    cursor = match.index + raw.length;
  }

  if (cursor < text.length) spans.push({ text: text.slice(cursor) });

  return spans;
};

// Turns one closed block of text into a Block.
export const parseBlock = (source: string): Block | null => {
  const text = source.replace(/\s+$/, "");
  if (!text.trim()) return null;

  if (RULE.test(text)) return { kind: "rule" };

  const heading = HEADING.exec(text);
  if (heading) {
    return {
      kind: "heading",
      level: heading[1]!.length,
      spans: parseInline(heading[2]!),
    };
  }

  const quote = QUOTE.exec(text);
  if (quote) return { kind: "quote", spans: parseInline(quote[1]!) };

  const lines = text.split("\n");

  const table = parseTable(lines);
  if (table) return table;

  if (lines.every((line) => LIST_ITEM.test(line))) {
    return parseList(lines);
  }

  return { kind: "paragraph", spans: parseInline(text.replace(/\n/g, " ")) };
};

// Splits a table row into trimmed cells, honouring escaped pipes.
export const splitRow = (line: string): string[] => {
  const inner = TABLE_ROW.exec(line)?.[1] ?? "";
  const cells: string[] = [];
  let current = "";

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];

    if (char === "\\" && inner[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }

    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());

  return cells;
};

const alignOf = (cell: string): Alignment => {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");

  if (left && right) return "center";
  if (right) return "right";

  return "left";
};

// Parses a markdown table: header row, separator row, then body rows.
export const parseTable = (lines: string[]): TableBlock | null => {
  if (lines.length < 2) return null;
  if (!TABLE_SEPARATOR.test(lines[1]!)) return null;
  if (!lines[0]!.includes("|")) return null;

  const header = splitRow(lines[0]!);
  const align = splitRow(lines[1]!).map(alignOf);
  const rows = lines.slice(2).map(splitRow);

  // Normalise row width so the renderer never reads past the header.
  const width = header.length;

  return {
    kind: "table",
    header,
    align: header.map((_, index) => align[index] ?? "left"),
    rows: rows.map((row) =>
      Array.from({ length: width }, (_, index) => row[index] ?? ""),
    ),
  };
};

// Parses list lines, keeping nesting from indentation and ordinal numbers.
export const parseList = (lines: string[]): Block => {
// Groups: 1 = indentation, 2 = marker, 3 = text.
const ordered = /\d/.test(LIST_ITEM.exec(lines[0]!)![2]!);
let counter = 0;

const items: ListItem[] = lines.map((line) => {
const match = LIST_ITEM.exec(line)!;
const indent = match[1]!.length;
const marker = match[2]!;
const isOrdinal = /\d/.test(marker);

if (isOrdinal) counter++;

return {
depth: Math.floor(indent / 2),
marker: isOrdinal ? `${counter}.` : "-",
spans: parseInline(match[3]!),
};
});

return { kind: "list", ordered, items };
};


// Accumulates streamed markdown without re-parsing what is already closed.
export class MarkdownStream {
  protected closed: Block[] = [];
  protected buffer = "";
  protected fence: { language?: string; lines: string[] } | null = null;

  // Appends a delta and returns the current document.
  push(delta: string): StreamDocument {
    this.buffer += delta;
    this.drain();

    return this.document();
  }

  // Closes whatever is open, so the final text is fully styled.
  finish(): StreamDocument {
    if (this.buffer) {
      if (this.fence) {
        this.fence.lines.push(this.buffer);
      } else {
        this.pending = `${this.pending}${this.pending ? "\n" : ""}${this.buffer}`;
      }
      this.buffer = "";
    }

    this.flushOpen();

    if (this.fence) {
      this.closed.push({
        kind: "code",
        language: this.fence.language,
        lines: this.fence.lines,
      });
      this.fence = null;
    }

    return this.document();
  }

  get text(): string {
    return this.buffer;
  }

  protected document(): StreamDocument {
    if (this.fence) {
      // The tail after the last newline has not been committed to the fence
      // yet; showing it keeps the last streamed line from disappearing.
      const visible = [...this.fence.lines];
      if (this.buffer) visible.push(this.buffer);

      return { blocks: [...this.closed], open: visible.join("\n") };
    }

    return { blocks: [...this.closed], open: this.buffer };
  }

  // Consumes complete blocks from the buffer, leaving the tail untouched.
  protected drain() {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.buffer.slice(0, newline);
      const rest = this.buffer.slice(newline + 1);
      const fenceMatch = FENCE.exec(line);

      if (this.fence) {
        if (fenceMatch) {
          this.closed.push({
            kind: "code",
            language: this.fence.language,
            lines: this.fence.lines,
          });
          this.fence = null;
        } else {
          this.fence.lines.push(line);
        }

        this.buffer = rest;
        continue;
      }

      if (fenceMatch) {
        this.flushOpen();
        this.fence = {
          language: fenceMatch[1]!.trim() || undefined,
          lines: [],
        };
        this.buffer = rest;
        continue;
      }

      // A blank line closes the pending paragraph.
      if (!line.trim()) {
        this.flushOpen();
        this.buffer = rest;
        continue;
      }

      this.buffer = rest;
      this.pending = `${this.pending}${this.pending ? "\n" : ""}${line}`;

      // Single-line blocks are complete as soon as their line ends.
      if (HEADING.test(line) || RULE.test(line)) this.flushOpen();
      // A list item only closes when a non-item line (or blank) arrives.
      if (LIST_ITEM.test(line) && rest.trim()) {
        if (!LIST_ITEM.test(rest.split("\n")[0] ?? "")) this.flushOpen();
      }

 // Table rows accumulate until a line that cannot belong to a table
 // arrives; without this each row became its own paragraph.
 if (this.pending.includes("|") && rest.trim()) {
 const next = rest.split("\n")[0] ?? "";

 if (!next.includes("|") && next.trim()) this.flushOpen();
 }
    }
  }

  protected pending = "";

  protected flushOpen() {
    if (!this.pending.trim()) {
      this.pending = "";
      return;
    }

    const block = parseBlock(this.pending);
    if (block) this.closed.push(block);
    this.pending = "";
  }
}
