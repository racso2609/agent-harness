import type { ApprovalRequest, ILogger } from "@racso/core";
import { createLogger } from "@racso/core";
import { render } from "ink";
import { App, type TuiLine, type TuiState } from "./tui/App";
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
protected started = false;

// Registers the callbacks the app needs and mounts Ink.
start(options: {
onSubmit: (prompt: string) => void;
onExit: () => void;
}) {
this.onSubmit = options.onSubmit;
this.onExit = options.onExit;
this.started = true;
this.mount();
}

protected mount() {
this.instance = render(
<App
state={this.state}
onSubmit={(prompt) => this.onSubmit(prompt)}
onExit={() => this.onExit()}
/>,
);
}

protected pushLine(kind: TuiLine["kind"], text: string) {
const lines = [...this.state.lines, { kind, text }];

this.state = { ...this.state, lines: lines.slice(-MAX_LINES) };
this.instance?.rerender(
<App
state={this.state}
onSubmit={(prompt) => this.onSubmit(prompt)}
onExit={() => this.onExit()}
/>,
);
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
{ id: event.handle.spawnId, agent: event.handle.agentId, status: event.handle.status },
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

async promptApproval(request: ApprovalRequest) {
this.pushLine(
"notice",
`approval required: ${request.tool} [${request.kind}] ${request.subject}`,
);
// Ink owns stdin, so an explicit prompt would fight the input box. The
// safest default while the TUI is a prototype is to refuse side effects.
return "deny" as const;
}

async renderImage(url: string) {
this.pushLine("notice", `[image] ${url.slice(0, 32)}…`);
}

close() {
this.instance?.unmount();
}
}

export { TuiUiAdapter };
