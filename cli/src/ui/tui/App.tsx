import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { UiStatus } from "../UiAdapter";
import type {
Alignment,
Block,
InlineSpan,
StreamDocument,
TableBlock,
} from "./markdown";
import { colorFor, elapsedFor, iconFor, type SpawnEntry, visibleSpawns } from "./progress";
import { GLYPH, resolveTheme, type Role, type Theme } from "./theme";
import { collapse } from "./collapse";

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

const CHOICES = [
{ key: "allow" as const, label: "allow once" },
{ key: "always" as const, label: "always allow this" },
{ key: "deny" as const, label: "deny" },
];

export const App = ({
state,
onSubmit,
onExit,
onDecision,
onToggle,
onToggleAll,
}: AppProps) => {
const [draft, setDraft] = useState("");
const [choice, setChoice] = useState(0);
const [now, setNow] = useState(() => Date.now());
const approval = state.approval;
const theme = state.theme;

const lingering = state.spawns.some(
(spawn) => spawn.status !== "running" && spawn.finishedAt,
);

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

const visible = visibleSpawns(state.spawns, now);

return (
<Box flexDirection="column" height="100%">
<Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
{state.lines.slice(-60).map((line, index) => (
<Line
key={index}
line={line}
theme={theme}
running={state.running ?? false}
expanded={state.expanded.has(index)}
/>
))}
</Box>

{visible.length > 0 && (
<Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
{visible.map((spawn) => (
<Text key={spawn.id} color={colorFor(spawn.status)}>
{iconFor(spawn.status)} {spawn.agent} · {spawn.id} · {elapsedFor(spawn, now)}
</Text>
))}
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
}: {
line: TuiLine;
theme: Theme;
running: boolean;
expanded: boolean;
}) => {
// A spawn entry is informational, so it borrows the notice style.
const role: Role = line.role === "spawn" ? "notice" : line.role;
const style = theme[role];
const glyph = line.role === "spawn" ? "◈ " : GLYPH[role];

if (line.role === "reasoning") {
const text = [
...line.doc.blocks.map((block) => plainBlock(block)),
line.doc.open,
]
.filter(Boolean)
.join("\n");
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
<Block key={index} block={block} role={line.role} style={style} />
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
return [block.header, ...block.rows]
.map((row) => row.join(" | "))
.join("\n");
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
}: {
block: Block;
role: Role;
style: ReturnType<typeof resolveTheme>[Role];
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
return <Table block={block} style={style} />;

case "heading":
return (
<Text {...style} bold>
{glyph}
<Spans spans={block.spans} style={style} />
</Text>
);

default:
return (
<Text {...style}>
{glyph}
<Spans spans={block.spans} style={style} />
</Text>
);
}
};

// Renders a markdown table as aligned columns. Borders are drawn with box
// characters so the grid survives narrow terminals; each column is padded to
// its widest cell and aligned as the separator row requested.
const Table = ({
block,
style,
}: {
block: TableBlock;
style: ReturnType<typeof resolveTheme>[Role];
}) => {
const widths = block.header.map((cell, index) =>
Math.max(
cell.length,
...block.rows.map((row) => (row[index] ?? "").length),
),
);

const pad = (text: string, width: number, align: Alignment): string => {
const gap = Math.max(0, width - text.length);

if (align === "right") return " ".repeat(gap) + text;
if (align === "center") {
const left = Math.floor(gap / 2);
return " ".repeat(left) + text + " ".repeat(gap - left);
}

return text + " ".repeat(gap);
};

const rule = (left: string, mid: string, right: string) =>
left + widths.map((width) => "─".repeat(width + 2)).join(mid) + right;

const row = (cells: string[]) =>
"│ " +
cells
.map((cell, index) => pad(cell, widths[index]!, block.align[index]!))
.join(" │ ") +
" │";

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
