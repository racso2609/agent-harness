import type {
ApprovalDecision,
ApprovalRequest,
ILogger,
LoggerSink,
} from "@racso/core";
import { createLogger } from "@racso/core";
import { clearPrompt, input, printImage, printLogo, restorePrompt } from "@/terminal/stdin";
import type { UiAdapter, UiEvent, UiStatus } from "./UiAdapter";

// Formats the status bar line shared by both renderers.
export const formatStatusBar = (status: UiStatus): string => {
const parts: string[] = [];

if (status.provider) parts.push(`provider: ${status.provider}`);
if (status.model) parts.push(`model: ${status.model}`);
if (status.agent) parts.push(`agent: ${status.agent}`);
if (status.tokens != null) parts.push(`tokens: ${status.tokens}`);
if (status.costUsd != null) parts.push(`cost: $${status.costUsd.toFixed(4)}`);

return parts.join(" · ");
};

// Line-oriented renderer: the behaviour the CLI shipped with. It stays the
// default so existing sessions and tests keep working while the ink TUI is
// built behind a flag.
class CliUiAdapter implements UiAdapter {
// Writes a line above the prompt without clobbering what the user typed.
notify(message: string) {
clearPrompt();
process.stdout.write(`${message}\n`);
restorePrompt();
}

// Streams a partial piece of output on the same line.
protected writeChunk(text: string) {
clearPrompt();
process.stdout.write(text);
restorePrompt();
}

// Builds a core logger whose lines are routed through the prompt-safe sink.
logger(): ILogger {
const sink: LoggerSink = (line) => {
clearPrompt();
process.stderr.write(`${line}\n`);
restorePrompt();
};
return createLogger(sink);
}

render(event: UiEvent) {
switch (event.type) {
case "status":
if (formatStatusBar(event.status)) this.notify(formatStatusBar(event.status));
break;
case "notice":
this.notify(event.message);
break;
case "text":
this.writeChunk(event.delta);
break;
case "reasoning":
// Reasoning is noise on a scrollback terminal; the TUI renders it.
break;
case "toolStart":
this.notify(`→ ${event.name}`);
break;
case "toolOutput":
this.writeChunk(event.chunk);
break;
case "toolEnd":
break;
case "turnStart":
break;
case "turnEnd":
if (event.outcome && event.outcome.pending.length) {
this.notify(`pending: ${event.outcome.pending.join(", ")}`);
}
break;
case "spawn":
this.notify(`spawn ${event.handle.spawnId} started (${event.handle.agentId})`);
break;
case "spawnSettled":
this.notify(
`spawn ${event.handle.spawnId} ${event.handle.status}` +
(event.handle.error ? `: ${event.handle.error}` : ""),
);
break;
case "reset":
this.reset();
break;
}
}

// Renders a base64/data-url image inline in the terminal.
async renderImage(url: string) {
const base64 = url.split(",").pop() ?? url;
await printImage(base64);
}

// Redraws the screen with the logo, preserving session state.
reset() {
process.stdout.write("\x1Bc");
printLogo();
}

// Asks the user to approve a side-effect request.
async promptApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
const answer = (
await input(
`Allow ${request.tool} [${request.kind}] ${request.subject}? ` +
`[y/N/a=always] `,
)
).trim();

if (/^a(lways)?$/i.test(answer)) return "always";
return /^y(es)?$/i.test(answer) ? "allow" : "deny";
}

// The line renderer leaves the terminal as the prompt owns it.
close() {
if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
}

export { CliUiAdapter };
