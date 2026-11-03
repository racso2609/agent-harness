import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { UiStatus } from "../UiAdapter";
import type { Block, InlineSpan, StreamDocument, TableBlock } from "./markdown";
import { colorFor, elapsedFor, iconFor, type SpawnEntry, spawnStrip } from "./progress";
import { GLYPH, resolveTheme, type Role, type Theme } from "./theme";
import { collapse } from "./collapse";
import { fitColumns, truncateCell, wrapText } from "./layout";
import { bottomView, clampView, measureEntries, visibleWindow, type ScrollView } from "./scroll";
import { chromeRows, nextView, viewportRows } from "./viewport";

// One rendered entry. `answer` and `reasoning` carry the live markdown
// document; everything else is plain text.
export type TuiLine =
  | { role: "user"; text: string }
  | { role: "notice" | "tool" | "spawn"; text: string }
  | { role: "answer" | "reasoning"; doc: StreamDocument };

export interface TuiApproval {
  tool: string;
  kind: string;
  subject: string;
}

export type TuiSpawn = SpawnEntry;

export interface TuiState {
  lines: TuiLine[];
  status: UiStatus;
  activity?: string;
  spawns: TuiSpawn[];
  // Children restored from a previous run: read-only, never ticking.
  history: TuiSpawn[];
  approval?: TuiApproval;
  theme: Theme;
  // A turn is in flight: reasoning and tool output preview their tail.
  running?: boolean;
  // Entries the user expanded explicitly.
  expanded: Set<number>;
}

interface AppProps {
  state: TuiState;
  onSubmit: (prompt: string) => void;
  onExit: () => void;
  onDecision: (decision: "allow" | "deny" | "always") => void;
  onToggle: (kind: "reasoning" | "tool", index: number) => void;
  onToggleAll: (kind: "reasoning" | "tool") => void;
}

// Columns reserved for the pane border and its horizontal padding.
const PANEL_CHROME = 6;
// Below this the layout stops shrinking and lets the terminal scroll.
const MIN_WIDTH = 20;

const CHOICES = [
  { key: "allow" as const, label: "allow once" },
  { key: "always" as const, label: "always allow this" },
  { key: "deny" as const, label: "deny" },
];

// Plain text of one entry: what `Line` collapses and what the measurement wraps
// with. Both must agree, otherwise the pane reserves a different number of rows
// than it paints and the transcript jitters while scrolling.
const entryText = (line: TuiLine): string => {
  if (line.role === "answer" || line.role === "reasoning") {
    return [...line.doc.blocks.map((block) => plainBlock(block)), line.doc.open]
      .filter(Boolean)
      .join("\n");
  }

  return (line as Extract<TuiLine, { text: string }>).text;
};

export const App = ({ state, onSubmit, onExit, onDecision, onToggle, onToggleAll }: AppProps) => {
  const [draft, setDraft] = useState("");
  const [choice, setChoice] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Where the transcript is looking. `bottomView()` starts pinned to the bottom,
  // like a shell: the newest line is the first thing the user sees.
  const [view, setView] = useState<ScrollView>(() => bottomView());
  const approval = state.approval;
  const theme = state.theme;
  const { stdout } = useStdout();
  // The transcript is a viewport, not "the last N entries": its height comes
  // from the terminal and is rebuilt on resize, which is also when the scroll
  // position has to be re-clamped.
  const { rows } = useWindowSize();

  // Only a child of this run needs the clock: a running one counts up and a
  // settled one lingers. Restored rows keep their frozen time, so they never
  // force a repaint.
  const lingering = state.spawns.length > 0;
  useEffect(() => {
    if (!lingering) return;

    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [lingering]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
      return;
    }

    // Collapse controls work while typing so an expanding turn can be quieted
    // without losing the draft.
    if (key.ctrl && input === "r") {
      onToggleAll("reasoning");
      return;
    }

    if (key.ctrl && input === "t") {
      onToggleAll("tool");
      return;
    }

    // Scroll keys come before text input so a PageUp or an arrow no longer
    // disappears into the draft. In the approval box the arrows pick an option,
    // which `nextView` knows because it is told about `approval`; paging still
    // scrolls there, so an older part of the transcript can be read while a
    // question waits.
    const scrolled = nextView(
      key,
      input,
      effectiveView,
      measured.total,
      viewportLines,
      approval != null,
    );

    if (scrolled) {
      setView(scrolled);
      return;
    }

    if (approval) {
      if (key.leftArrow || key.upArrow) {
        setChoice((current) => (current + CHOICES.length - 1) % CHOICES.length);
        return;
      }

      if (key.rightArrow || key.downArrow || key.tab) {
        setChoice((current) => (current + 1) % CHOICES.length);
        return;
      }

      if (key.return) {
        onDecision(CHOICES[choice]!.key);
        setChoice(0);
        return;
      }

      if (input === "y") {
        onDecision("allow");
        setChoice(0);
        return;
      }

      if (input === "a") {
        onDecision("always");
        setChoice(0);
        return;
      }

      if (input === "n" || key.escape) {
        onDecision("deny");
        setChoice(0);
        return;
      }

      return;
    }

    if (key.return) {
      const value = draft.trim();

      // Empty input + enter opens the last collapsible entry the user can see.
      if (!value) {
        const lastIndex = state.lines.length - 1;
        const last = state.lines[lastIndex];

        if (last && (last.role === "reasoning" || last.role === "tool")) {
          onToggle(last.role, lastIndex);
          return;
        }

        return;
      }

      // Sending is the one moment the user asked to see what comes next. Any
      // other content change (a streamed delta, a child settling, an automatic
      // turn) must leave the scroll where the user put it.
      setView(bottomView());
      setDraft("");
      onSubmit(value);
      return;
    }

    if (key.backspace || key.delete) {
      setDraft((current) => current.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setDraft((current) => current + input);
    }
  });

  // The panel frame and its padding eat a few columns; keep a floor so the
  // layout never collapses on a tiny terminal.
  const width = Math.max(
    MIN_WIDTH,
    ((stdout as { columns?: number } | undefined)?.columns ?? 80) - PANEL_CHROME,
  );
  const strip = spawnStrip(state.spawns, state.history ?? [], now);
  const stripRows = strip.rows.length + (strip.hidden > 0 ? 1 : 0);
  // What the transcript can paint: the terminal, minus the panels stacked under
  // it. Derived on every render, so a resize moves the viewport and the scroll
  // position is re-clamped right below.
  const viewportLines = viewportRows(rows, chromeRows({ stripRows, approval: approval != null }));
  const running = state.running ?? false;
  // Measuring is the expensive part (it wraps every entry), so it only runs when
  // the transcript or the width it is wrapped to changes, never per keystroke.
  const measured = useMemo(
    () =>
      measureEntries(state.lines, {
        width,
        running,
        expanded: state.expanded,
        textOf: entryText,
      }),
    [state.lines, state.expanded, running, width],
  );
  // The state holds what the user asked for; the effective view is that ask
  // squeezed into a transcript that may have grown or shrunk since.
  const effectiveView = clampView(view, measured.total, viewportLines);
  // Resolved once so the window, the padding and the panel agree on how many
  // rows are painted. Ink clips a box that grows past its height, and it clips
  // the bottom, which is exactly where the newest lines live.
  const visible = visibleWindow({ heights: measured.heights, viewportLines, view: effectiveView });

  return (
    <Box flexDirection="column" height="100%">
      <Box
        flexDirection="column"
        height={viewportLines}
        borderStyle="round"
        paddingX={1}
        // A row entering or leaving the viewport is painted whole, so for one
        // frame the content can be taller than the box. Clipping hides that
        // overflow instead of letting it push the panels below and make the
        // layout dance every time the scroll moves a single line.
        overflowY="hidden"
      >
        {Array.from({ length: visible.padTop }, (_, blank) => (
          <Text key={`pad-${blank}`}> </Text>
        ))}
        {visible.rows.map(({ absolute }) => (
          <Line
            // Keyed by the position in the transcript, never by the position in
            // the window: a shifting key makes React reuse the wrong entry while
            // scrolling, which is half of the "it jumps" bug.
            key={absolute}
            line={state.lines[absolute]!}
            theme={theme}
            running={running}
            // `expanded` holds absolute transcript indexes (see toggleEntry in
            // TuiUiAdapter), so it is queried with `absolute`, never with a
            // window index.
            expanded={state.expanded.has(absolute)}
            width={width}
          />
        ))}
      </Box>

      {strip.rows.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          {strip.rows.map((spawn) => (
            <Text key={spawn.id} color={colorFor(spawn.status)} dimColor={spawn.restored}>
              {iconFor(spawn.status)} {spawn.agent} · {spawn.id} · {elapsedFor(spawn, now)}
            </Text>
          ))}
          {strip.hidden > 0 && <Text dimColor>+{strip.hidden} older from previous runs</Text>}
        </Box>
      )}

      {approval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            Allow {approval.tool} [{approval.kind}]
          </Text>
          <Text>{approval.subject}</Text>
          <Box marginTop={1}>
            {CHOICES.map((option, index) => (
              <Text
                key={option.key}
                color={index === choice ? "green" : undefined}
                inverse={index === choice}
              >
                {index === choice ? "› " : "  "}
                {option.label}
              </Text>
            ))}
          </Box>
          <Text dimColor>[y] allow · [a] always · [n] deny · ←/→ + enter</Text>
        </Box>
      ) : (
        <Box borderStyle="round" paddingX={1}>
          <Text color="green">{"> "}</Text>
          <Text>{draft}</Text>
          <Text dimColor>{state.activity ? ` ${state.activity}` : ""}</Text>
        </Box>
      )}

      <Box paddingX={1}>
        <Text dimColor>{statusLine(state.status)}</Text>
      </Box>
    </Box>
  );
};

// Renders one entry with the style of its role. Colour alone is not enough to
// tell speakers apart, so each role also gets a glyph.
const Line = ({
  line,
  theme,
  running,
  expanded,
  width,
}: {
  line: TuiLine;
  theme: Theme;
  running: boolean;
  expanded: boolean;
  width: number;
}) => {
  // A spawn entry is informational, so it borrows the notice style.
  const role: Role = line.role === "spawn" ? "notice" : line.role;
  const style = theme[role];
  const glyph = line.role === "spawn" ? "◈ " : GLYPH[role];

  if (line.role === "reasoning") {
    const text = entryText(line);
    const view = collapse({
      role: "reasoning",
      text,
      width: Infinity,
      running,
      expanded,
    });

    if (!view.shown) {
      return (
        <Text {...style}>
          {glyph}
          {view.summary} · ctrl+r
        </Text>
      );
    }

    return (
      <Box flexDirection="column">
        <Text {...style}>
          {glyph}
          {view.hidden ? `${view.summary} · ctrl+r` : view.summary}
        </Text>
        <Box paddingLeft={2}>
          <Text {...style}>{view.shown}</Text>
        </Box>
      </Box>
    );
  }

  if (line.role === "answer") {
    return (
      <Box flexDirection="column">
        {line.doc.blocks.map((block, index) => (
          <Block key={index} block={block} role={line.role} style={style} width={width} />
        ))}
        {line.doc.open ? <Text {...style}>{line.doc.open}</Text> : null}
      </Box>
    );
  }

  const textLine = line as Extract<TuiLine, { text: string }>;

  if (line.role === "tool") {
    const view = collapse({
      role: "tool",
      text: textLine.text,
      width: Infinity,
      running,
      expanded,
    });

    if (!view.shown) {
      return (
        <Text {...style}>
          {glyph}
          {view.summary} · ctrl+t
        </Text>
      );
    }

    return (
      <Box flexDirection="column">
        <Text {...style}>
          {glyph}
          {view.hidden ? `${view.summary} · ctrl+t` : view.summary}
        </Text>
        <Box paddingLeft={2}>
          <Text {...style}>{view.shown}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Text {...style}>
      {glyph}
      {textLine.text}
    </Text>
  );
};

// Flattens a block to plain text for the collapse window.
const plainBlock = (block: Block): string => {
  const spans = (parts: InlineSpan[]) => parts.map((span) => span.text).join("");

  switch (block.kind) {
    case "code":
      return block.lines.join("\n");
    case "list":
      return block.items
        .map((item) => `${" ".repeat(item.depth * 2)}${item.marker} ${spans(item.spans)}`)
        .join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.join(" | ")).join("\n");
    case "rule":
      return "───";
    case "heading":
    case "quote":
    case "paragraph":
      return spans(block.spans);
  }
};

// Closed blocks are styled definitively; inline spans map to ink props.
const Block = ({
  block,
  role,
  style,
  width,
}: {
  block: Block;
  role: Role;
  style: ReturnType<typeof resolveTheme>[Role];
  width: number;
}) => {
  const glyph = role === "reasoning" ? GLYPH.reasoning : "";

  switch (block.kind) {
    case "code":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {block.lines.map((codeLine, index) => (
            <Text key={index} dimColor color={style.color}>
              {codeLine || " "}
            </Text>
          ))}
        </Box>
      );

    case "rule":
      return <Text {...style}>{"─".repeat(40)}</Text>;

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Box key={index} paddingLeft={item.depth * 2}>
              <Text {...style}>
                {glyph}
                {item.marker === "-" ? "•" : item.marker} <Spans spans={item.spans} style={style} />
              </Text>
            </Box>
          ))}
        </Box>
      );

    case "table":
      return <Table block={block} style={style} width={width} />;

    case "heading":
      return (
        <Text {...style} bold>
          {glyph}
          <Spans spans={block.spans} style={style} />
        </Text>
      );

    default: {
      const text = block.spans.map((span) => span.text).join("");
      const lines = wrapText(text, leaveRoomFor(glyph, width));

      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <Text key={index} {...style}>
              {index === 0 ? glyph : " ".repeat(glyph.length)}
              {line}
            </Text>
          ))}
        </Box>
      );
    }
  }
};

// Keeps room for the role glyph so wrapped paragraphs stay aligned.
const leaveRoomFor = (glyph: string, width: number): number => Math.max(1, width - glyph.length);

// Cuts inline spans to a plain-text width, preserving each span's styling.
const truncateSpans = (spans: InlineSpan[], width: number): InlineSpan[] => {
  const result: InlineSpan[] = [];
  let remaining = width;

  for (const span of spans) {
    if (remaining <= 0) break;

    if (span.text.length <= remaining) {
      result.push(span);
      remaining -= span.text.length;
      continue;
    }

    result.push({ ...span, text: span.text.slice(0, remaining) });
    remaining = 0;
  }

  return result;
};

// Renders a markdown table as aligned columns. Columns shrink to fit the
// terminal (widest first) and any cell that no longer fits is ellipsised, so a
// wide table stays a grid instead of wrapping into noise.
const Table = ({
  block,
  style,
  width,
}: {
  block: TableBlock;
  style: ReturnType<typeof resolveTheme>[Role];
  width: number;
}) => {
  const plain = (cell: InlineSpan[]) => cell.map((span) => span.text).join("");
  const natural = block.header.map((cell, index) =>
    Math.max(plain(cell).length, ...block.rows.map((row) => plain(row[index] ?? []).length)),
  );
  const columns = fitColumns(natural, width);

  const rule = (left: string, mid: string, right: string) =>
    left + columns.map((column) => "─".repeat(column.width + 2)).join(mid) + right;

  const row = (cells: InlineSpan[][]) => {
    const parts = cells.map((cell, index) => {
      const column = columns[index]!;
      const text = truncateCell(plain(cell), column.width);
      const gap = Math.max(0, column.width - text.length);
      const align = block.align[index]!;
      const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
      const right = gap - left;

      // Spans are truncated as plain text, so the styled content must follow
      // the same cut or the column would overflow its rule.
      return { spans: truncateSpans(cell, column.width), left, right };
    });

    return (
      <>
        {"│ "}
        {parts.map((part, index) => (
          <Text key={index}>
            {" ".repeat(part.left)}
            <Spans spans={part.spans} style={style} />
            {" ".repeat(part.right)}
            {index === parts.length - 1 ? " │" : " │ "}
          </Text>
        ))}
      </>
    );
  };

  return (
    <Box flexDirection="column">
      <Text {...style} bold>
        {rule("┌", "┬", "┐")}
      </Text>
      <Text {...style} bold>
        {row(block.header)}
      </Text>
      <Text {...style}>{rule("├", "┼", "┤")}</Text>
      {block.rows.map((cells, index) => (
        <Text key={index} {...style}>
          {row(cells)}
        </Text>
      ))}
      <Text {...style}>{rule("└", "┴", "┘")}</Text>
    </Box>
  );
};

const Spans = ({
  spans,
  style,
}: {
  spans: InlineSpan[];
  style: ReturnType<typeof resolveTheme>[Role];
}) => (
  <>
    {spans.map((span, index) => (
      <Text
        key={index}
        {...style}
        bold={span.bold || style.bold}
        italic={span.italic}
        color={span.code ? "cyan" : style.color}
      >
        {span.text}
      </Text>
    ))}
  </>
);

const statusLine = (status: UiStatus): string => {
  const parts = [status.provider, status.model, status.agent].filter(Boolean);
  if (status.tokens != null) parts.push(`${status.tokens} tok`);
  if (status.costUsd != null) parts.push(`$${status.costUsd.toFixed(4)}`);

  return parts.join(" · ") || "ready";
};
