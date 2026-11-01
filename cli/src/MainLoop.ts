import {
Config,
createHarness,
type ApprovalRequest,
type IHarness,
SUPPORTED_PROVIDERS,
} from "@racso/core";
import { CommandContext, CommandRepository } from "@/commands/CommandRepository";
import { createFlows, type Flows } from "@/flows";
import { startSetup } from "@/flows/startSetup";
import { createLogger, type ILogger } from "@racso/core";
import { input } from "@/terminal/stdin";
import { CliUiAdapter } from "@/ui/CliUiAdapter";
import { TuiUiAdapter } from "@/ui/TuiUiAdapter";
import { toStatusEvent, toUiEvents } from "@/ui/renderEvents";
import type { UiAdapter } from "@/ui/UiAdapter";

interface MainLoopOptions {
// Id of a previously persisted session to resume on boot.
sessionId?: string;
// Agent to use when starting a new session.
agent?: string;
// Configuration source; defaults to a new Config.
config?: Config;
// Renders the full-screen ink TUI instead of plain lines.
tui?: boolean;
}

class MainLoop {
harness: IHarness;
config: Config;
flows: Flows;
commands: CommandRepository;
ui: UiAdapter;
// Guard so the shutdown handler runs only once.
private closing = false;
// Prompts submitted by the TUI. The line renderer reads stdin directly.
private queue: string[] = [];
private pending: ((prompt: string) => void) | null = null;

constructor(options: MainLoopOptions = {}) {
this.config = options.config ?? new Config();
this.flows = createFlows([...SUPPORTED_PROVIDERS]);
this.commands = new CommandRepository();
this.ui = options.tui
? new TuiUiAdapter(this.config.config.ui?.theme)
: new CliUiAdapter();
this.harness = createHarness({
config: this.config,
logger: uiLogger(this.ui),
approval: (request: ApprovalRequest) => this.ui.promptApproval(request),
});
}

// Boots the session, wiring key handling and running the prompt loop.
// Runs the interactive config setup first when no provider is configured.
async start(options: MainLoopOptions = {}) {
if (this.config.needsSetup()) {
await startSetup(this.config);
}

await this.harness.initialize({
sessionId: options.sessionId,
agent: options.agent,
});

// Children starting and settling are pushed, not polled: the UI shows a
// child the moment it exists, including ones launched inside a turn.
this.harness.onSpawnEvent((event) => {
this.ui.render(
event.type === "started"
? { type: "spawn", handle: event.handle }
: { type: "spawnSettled", handle: event.handle },
);
});

if (this.isTui()) {
// Ink owns stdin, so the app pushes prompts into the same loop.
(this.ui as TuiUiAdapter).start({
onSubmit: (prompt) => this.enqueue(prompt),
onExit: () => this.shutdown(0),
});
} else {
this.printStatus();
}

this.installKeyHandlers();
await this.loop();
}

protected isTui(): boolean {
return this.ui instanceof TuiUiAdapter;
}

// Ctrl-C triggers cleanup and exit.
protected installKeyHandlers() {
process.on("SIGINT", () => this.shutdown(130));
}

// Hands a prompt to the loop waiting for one.
protected enqueue(prompt: string) {
if (this.pending) {
const resolve = this.pending;
this.pending = null;
resolve(prompt);
return;
}
this.queue.push(prompt);
}

// Next prompt: from the TUI queue, or from stdin in line mode.
protected nextPrompt(): Promise<string> {
if (!this.isTui()) {
return input("Type your prompt: ", { commands: this.commands.list() });
}

const queued = this.queue.shift();
if (queued !== undefined) return Promise.resolve(queued);

return new Promise<string>((resolve) => {
this.pending = resolve;
});
}

// Main prompt loop: reads, dispatches to the harness and renders output.
protected async loop() {
while (true) {
const prompt = (await this.nextPrompt()).trim();
if (!prompt) continue;

if (prompt.startsWith("/")) {
const handled = await this.commands.run(prompt, this.commandContext());
if (!handled) {
this.ui.render({
type: "notice",
message: `Unknown command: ${prompt}. Type /help for a list.`,
});
}
continue;
}

this.ui.render({ type: "turnStart", prompt });

try {
const { text, images, outcome } = await this.harness.ask(prompt, {
onEvent: (event) => {
for (const uiEvent of toUiEvents(event)) this.ui.render(uiEvent);
},
});

// The final text is authoritative: the stream may have been empty (no
// deltas) or cut short. The line renderer prints it as one notice; the TUI
// replaces the accumulated answer with it.
if (text) {
this.ui.render({ type: "answer", text });
}
for (const image of images ?? []) {
await this.ui.renderImage(image.url);
}
this.ui.render({ type: "turnEnd", text, outcome });
this.printStatus();
} catch (err) {
this.ui.render({
type: "notice",
message: `failed to handle prompt: ${String(err)}`,
});
}
}
}

protected printStatus() {
this.ui.render(toStatusEvent(this.harness.status()));
}

// Dependencies exposed to slash command handlers.
protected commandContext(): CommandContext {
return {
harness: this.harness,
flows: this.flows,
exit: () => this.shutdown(0),
clear: () => this.ui.render({ type: "reset" }),
notify: (message) => this.ui.render({ type: "notice", message }),
help: () => this.commands.helpText(),
};
}

// Persists the session, restores the terminal and exits.
protected shutdown(code: number) {
if (this.closing) return;
this.closing = true;

try {
this.harness.shutdown();
} catch (err) {
this.ui.render({
type: "notice",
message: `failed to persist session on shutdown: ${String(err)}`,
});
}

this.ui.close();
process.exit(code);
}
}

// The logger is optional in the UI contract; line mode always provides one.
const uiLogger = (ui: UiAdapter): ILogger => {
	if ("logger" in ui && typeof ui.logger === "function") {
		return (ui.logger as () => ILogger)();
	}
	return createLogger(() => {});
};

export { MainLoop };
export type { MainLoopOptions };
