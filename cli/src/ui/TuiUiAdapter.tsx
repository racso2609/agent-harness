import type { ApprovalDecision, ApprovalRequest, ILogger, UiTheme } from "@racso/core";
import { createLogger } from "@racso/core";
import { render } from "ink";
import { App, type TuiApproval, type TuiLine, type TuiState } from "./tui/App";
import { MarkdownStream } from "./tui/markdown";
import { resolveTheme, type Theme } from "./tui/theme";
import type { UiAdapter, UiEvent } from "./UiAdapter";

const MAX_LINES = 400;

// Ink-backed renderer: full-screen panes, live activity and a spawn strip.
// It owns one Ink instance and re-renders on every state change; the loop
// keeps calling render(event) exactly as it does with the line renderer.
class TuiUiAdapter implements UiAdapter {
protected state: TuiState;
protected instance?: ReturnType<typeof render>;
protected onSubmit: (prompt: string) => void = () => {};
protected onExit: () => void = () => {};
// Resolver for the approval currently on screen, if any.
protected pendingApproval: ((decision: ApprovalDecision) => void) | null = null;
// Markdown accumulators for the two streamed roles. Kept out of the state so
// keystrokes never re-parse what already arrived.
protected streams: Partial<Record<"answer" | "reasoning", MarkdownStream>> = {};

constructor(theme?: UiTheme) {
this.state = {
lines: [],
status: {},
spawns: [],
theme: resolveTheme(theme),
};
}

// Registers the callbacks the app needs and mounts Ink.
start(options: {
onSubmit: (prompt: string) => void;
onExit: () => void;
}) {
this.onSubmit = options.onSubmit;
this.onExit = options.onExit;
this.mount();
}

protected get theme(): Theme {
return this.state.theme;
}

protected element() {
return (
<App
state={this.state}
onSubmit={(prompt) => this.onSubmit(prompt)}
onExit={() => this.onExit()}
onDecision={(decision) => this.resolveApproval(decision)}
/>
);
}

protected mount() {
const element = this.element();

if (!this.instance) {
this.instance = render(element);
return;
}

this.instance.rerender(element);
}

// Resolves the approval shown in the app and returns to the input box.
protected resolveApproval(decision: ApprovalDecision) {
const resolve = this.pendingApproval;
this.pendingApproval = null;
this.state = { ...this.state, approval: undefined };
this.mount();
resolve?.(decision);
}

protected pushLine(line: TuiLine) {
const lines = [...this.state.lines, line];

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.mount();
}

// Appends a delta to the streamed role. The markdown stream owns block
// boundaries, so the same role keeps growing in one entry.
protected appendStream(role: "answer" | "reasoning", delta: string) {
const stream = (this.streams[role] ??= new MarkdownStream());
const doc = stream.push(delta);

this.replaceStreamEntry(role, doc);
}

// Closes the stream of a role, styling its final block.
protected finishStream(role: "answer" | "reasoning") {
const stream = this.streams[role];
if (!stream) return;

const doc = stream.finish();
this.replaceStreamEntry(role, doc);
this.streams[role] = undefined;
}

// Replaces the streamed answer of the current turn with the final text.
protected replaceStreamWith(role: "answer" | "reasoning", text: string) {
const stream = new MarkdownStream();
stream.push(text);
const doc = stream.finish();

this.streams[role] = undefined;

const lines = [...this.state.lines];
const last = lines.at(-1);

if (last && last.role === role) {
lines[lines.length - 1] = { role, doc };
} else {
lines.push({ role, doc });
}

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.mount();
}

protected replaceStreamEntry(
role: "answer" | "reasoning",
doc: ReturnType<MarkdownStream["push"]>,
) {
const lines = [...this.state.lines];
const last = lines.at(-1);

const entry: TuiLine = { role, doc };

// The streamed role occupies the last entry while it is being written; once
// another role interrupts, a fresh entry is started.
if (last && last.role === role) {
lines[lines.length - 1] = entry;
} else {
lines.push(entry);
}

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.mount();
}

render(event: UiEvent) {
switch (event.type) {
case "status":
this.state = { ...this.state, status: event.status };
break;
case "notice":
this.pushLine({ role: "notice", text: event.message });
return;
case "text":
this.appendStream("answer", event.delta);
return;
case "answer":
// The final text is authoritative: replace whatever the stream produced
// (it may have been empty or cut short).
this.replaceStreamWith("answer", event.text);
return;
case "reasoning":
this.appendStream("reasoning", event.delta);
this.state = { ...this.state, activity: "thinking" };
break;
case "toolStart":
// The input box reports what the turn is doing right now.
this.state = { ...this.state, activity: `working · ${event.name}` };
this.pushLine({ role: "tool", text: `→ ${event.name}` });
return;
case "toolOutput":
this.appendToolOutput(event.chunk);
return;
case "toolEnd":
this.state = { ...this.state, activity: "working" };
break;
case "turnStart":
this.pushLine({ role: "user", text: event.prompt });
this.state = { ...this.state, activity: "working" };
break;
case "turnEnd":
this.finishStream("answer");
this.finishStream("reasoning");
this.state = { ...this.state, activity: undefined };
if (event.outcome && event.outcome.pending.length) {
this.pushLine({
role: "notice",
text: `pending: ${event.outcome.pending.join(", ")}`,
});
return;
}
break;
case "spawn":
this.state = {
...this.state,
spawns: [
...this.state.spawns,
{
id: event.handle.spawnId,
agent: event.handle.agentId,
status: event.handle.status,
startedAt: event.handle.startedAt,
finishedAt: event.handle.finishedAt,
},
],
};
break;
case "spawnSettled":
this.state = {
...this.state,
spawns: this.state.spawns.map((spawn) =>
spawn.id === event.handle.spawnId
? {
...spawn,
status: event.handle.status,
startedAt: event.handle.startedAt,
finishedAt: event.handle.finishedAt,
}
: spawn,
),
};
break;
case "reset":
this.streams = {};
this.state = { ...this.state, lines: [] };
break;
}

this.mount();
}

// Live tool output: appended to the last tool entry so a chatty command does
// not create one line per chunk.
protected appendToolOutput(chunk: string) {
const lines = [...this.state.lines];
const last = lines.at(-1);

if (last && last.role === "tool") {
lines[lines.length - 1] = { role: "tool", text: last.text + chunk };
} else {
lines.push({ role: "tool", text: chunk });
}

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.mount();
}

logger(): ILogger {
return createLogger((line) => {
this.pushLine({ role: "notice", text: line });
});
}

// Shows the request as a selectable question and waits for the keystroke.
// Ink owns stdin, so the answer cannot come from a readline prompt.
promptApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
if (this.pendingApproval) return Promise.resolve("deny");

const approval: TuiApproval = {
tool: request.tool,
kind: request.kind,
subject: request.subject,
};

this.state = { ...this.state, approval };
this.mount();

return new Promise<ApprovalDecision>((resolve) => {
this.pendingApproval = resolve;
});
}

async renderImage(url: string) {
this.pushLine({ role: "notice", text: `[image] ${url.slice(0, 32)}…` });
}

close() {
this.resolveApproval("deny");
this.instance?.unmount();
}
}

export { TuiUiAdapter };
