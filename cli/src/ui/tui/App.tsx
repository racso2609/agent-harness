import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { UiStatus } from "../UiAdapter";

export interface TuiLine {
kind: "user" | "assistant" | "tool" | "notice" | "spawn";
text: string;
}

// Pending approval shown as a selectable question instead of a prompt read
// from stdin: ink owns stdin, so the answer is resolved from the key handler.
export interface TuiApproval {
tool: string;
kind: string;
subject: string;
}

export interface TuiState {
lines: TuiLine[];
status: UiStatus;
activity?: string;
spawns: Array<{ id: string; agent: string; status: string }>;
approval?: TuiApproval;
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

// Two panes: the conversation fills the top, the input and status bar are
// pinned at the bottom. Rendering only reads state; the loop owns it.
export const App = ({ state, onSubmit, onExit, onDecision }: AppProps) => {
const [draft, setDraft] = useState("");
const [choice, setChoice] = useState(0);
const approval = state.approval;

useInput((input, key) => {
if (key.ctrl && input === "c") {
onExit();
return;
}

// While an approval is pending, every keystroke belongs to the question.
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

// Shortcuts: y = allow, a = always, n/esc = deny.
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

{approval ? (
<Box flexDirection="column" borderStyle="round" paddingX={1}>
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
