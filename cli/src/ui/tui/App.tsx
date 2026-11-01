import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { UiStatus } from "../UiAdapter";
import type { Block, InlineSpan, StreamDocument } from "./markdown";
import { colorFor, elapsedFor, iconFor, type SpawnEntry, visibleSpawns } from "./progress";
import { GLYPH, resolveTheme, type Role, type Theme } from "./theme";

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
}

interface AppProps {
state: TuiState;
onSubmit: (prompt: string) => void;
onExit: () => void;
onDecision: (decision: "allow" | "deny" | "always") => void;
}

const CHOICES = [
{ key: "allow" as const, label: "allow once" },
{ key: "always" as const, label: "always allow this" },
{ key: "deny" as const, label: "deny" },
];

export const App = ({ state, onSubmit, onExit, onDecision }: AppProps) => {
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
setDraft("");
if (value) onSubmit(value);
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
<Line key={index} line={line} theme={theme} />
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
const Line = ({ line, theme }: { line: TuiLine; theme: Theme }) => {
// A spawn entry is informational, so it borrows the notice style.
const role: Role = line.role === "spawn" ? "notice" : line.role;
const style = theme[role];
const glyph = line.role === "spawn" ? "◈ " : GLYPH[role];

if (line.role === "answer" || line.role === "reasoning") {
return (
<Box flexDirection="column">
{line.doc.blocks.map((block, index) => (
<Block key={index} block={block} role={line.role} style={style} />
))}
{line.doc.open ? (
<Text {...style}>
{glyph}
{line.doc.open}
</Text>
) : null}
</Box>
);
}

const textLine = line as Extract<TuiLine, { text: string }>;

return (
<Text {...style}>
{glyph}
{textLine.text}
</Text>
);
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
<Text key={index} {...style}>
{glyph} • <Spans spans={item} style={style} />
</Text>
))}
</Box>
);

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
