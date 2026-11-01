import type { ApprovalDecision, ApprovalRequest, ILogger } from "@racso/core";
import { createLogger } from "@racso/core";
import { render } from "ink";
import { App, type TuiApproval, type TuiLine, type TuiState } from "./tui/App";
import type { UiAdapter, UiEvent } from "./UiAdapter";

const MAX_LINES = 400;

// Ink-backed renderer: full-screen panes, live activity and a spawn strip.
// It owns one Ink instance and re-renders on every state change; the loop
// keeps calling render(event) exactly as it does with the line renderer.
class TuiUiAdapter implements UiAdapter {
protected state: TuiState = { lines: [], status: {}, spawns: [] };
protected instance?: ReturnType<typeof render>;
protected onSubmit: (prompt: string) => void = () => {};
protected onExit: () => void = () => {};
// Resolver for the approval currently on screen, if any.
protected pendingApproval: ((decision: ApprovalDecision) => void) | null = null;

// Registers the callbacks the app needs and mounts Ink.
start(options: {
onSubmit: (prompt: string) => void;
onExit: () => void;
}) {
this.onSubmit = options.onSubmit;
this.onExit = options.onExit;
this.mount();
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

protected pushLine(kind: TuiLine["kind"], text: string) {
const lines = [...this.state.lines, { kind, text }];

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.mount();
}

render(event: UiEvent) {
switch (event.type) {
case "status":
this.state = { ...this.state, status: event.status };
break;
case "notice":
this.pushLine("notice", event.message);
return;
case "text":
this.appendToLast("assistant", event.delta);
return;
case "reasoning":
this.state = { ...this.state, activity: "thinking" };
break;
case "toolStart":
this.pushLine("tool", `→ ${event.name}`);
return;
case "toolOutput":
this.appendToLast("tool", event.chunk);
return;
case "toolEnd":
this.state = { ...this.state, activity: undefined };
break;
case "turnStart":
this.pushLine("user", event.prompt);
this.state = { ...this.state, activity: "working" };
break;
case "turnEnd":
this.state = { ...this.state, activity: undefined };
if (event.outcome && event.outcome.pending.length) {
this.pushLine("notice", `pending: ${event.outcome.pending.join(", ")}`);
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
},
],
};
break;
case "spawnSettled":
this.state = {
...this.state,
spawns: this.state.spawns.map((spawn) =>
spawn.id === event.handle.spawnId
? { ...spawn, status: event.handle.status }
: spawn,
),
};
break;
case "reset":
this.state = { ...this.state, lines: [] };
break;
}

this.mount();
}

// Appends to the last line of the given kind, so streamed deltas do not
// create one line per chunk.
protected appendToLast(kind: TuiLine["kind"], chunk: string) {
const lines = [...this.state.lines];
const last = lines.at(-1);

if (last && last.kind === kind) {
lines[lines.length - 1] = { kind, text: last.text + chunk };
} else {
lines.push({ kind, text: chunk });
}

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
}

logger(): ILogger {
return createLogger((line) => {
this.pushLine("notice", line);
});
}

// Shows the request as a selectable question and waits for the keystroke.
// Ink owns stdin, so the answer cannot come from a readline prompt.
promptApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
// A second request while one is on screen: refuse rather than queue, so the
// user always knows what they are answering.
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
this.pushLine("notice", `[image] ${url.slice(0, 32)}…`);
}

close() {
// Answer any approval still on screen before tearing the UI down.
this.resolveApproval("deny");
this.instance?.unmount();
}
}

export { TuiUiAdapter };
