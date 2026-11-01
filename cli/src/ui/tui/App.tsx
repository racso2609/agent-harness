import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { UiStatus } from "../UiAdapter";

export interface TuiLine {
kind: "user" | "assistant" | "tool" | "notice" | "spawn";
text: string;
}

export interface TuiState {
lines: TuiLine[];
status: UiStatus;
activity?: string;
spawns: Array<{ id: string; agent: string; status: string }>;
}

interface AppProps {
state: TuiState;
onSubmit: (prompt: string) => void;
onExit: () => void;
}

// Two panes: the conversation fills the top, the input and status bar are
// pinned at the bottom. Rendering only reads state; the loop owns it.
export const App = ({ state, onSubmit, onExit }: AppProps) => {
const [draft, setDraft] = useState("");

useInput((input, key) => {
if (key.ctrl && input === "c") {
onExit();
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

return (
<Box flexDirection="column" height="100%">
<Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
{state.lines.slice(-40).map((line, index) => (
<Text key={`${index}-${line.kind}`} dimColor={line.kind === "notice"}>
{labelFor(line)}
</Text>
))}
</Box>

{state.spawns.length > 0 && (
<Box borderStyle="single" paddingX={1} flexDirection="column">
{state.spawns.map((spawn) => (
<Text key={spawn.id}>
{spawn.id} · {spawn.agent} · {spawn.status}
</Text>
))}
</Box>
)}

<Box borderStyle="round" paddingX={1}>
<Text color="green">{"> "}</Text>
<Text>{draft}</Text>
<Text dimColor>{state.activity ? ` ${state.activity}` : ""}</Text>
</Box>

<Box paddingX={1}>
<Text dimColor>{statusLine(state.status)}</Text>
</Box>
</Box>
);
};

const labelFor = (line: TuiLine): string => {
switch (line.kind) {
case "user":
return `you: ${line.text}`;
case "tool":
return `  ${line.text}`;
case "spawn":
return `◈ ${line.text}`;
case "notice":
return `· ${line.text}`;
default:
return line.text;
}
};

const statusLine = (status: UiStatus): string => {
const parts = [status.provider, status.model, status.agent].filter(Boolean);
if (status.tokens != null) parts.push(`${status.tokens} tok`);
if (status.costUsd != null) parts.push(`$${status.costUsd.toFixed(4)}`);

return parts.join(" · ") || "ready";
};
