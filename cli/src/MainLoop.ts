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
import {
batchKey,
CONTINUATION_DROPPED_NOTICE,
CONTINUATION_PROMPT,
continuationDecision,
dropContinuations,
type QueuedPrompt,
} from "@/ui/continuation";
import { toStatusEvent, toUiEvents } from "@/ui/renderEvents";
import type { UiAdapter } from "@/ui/UiAdapter";

// Emits the children persisted in the session (previous runs) so the strip
// starts with what the session launched instead of empty. Only the core knows
// whether a load happened, so the loop asks instead of guessing.
export const showChildHistory = (harness: IHarness, ui: UiAdapter) => {
const handles = harness.childHistory();
if (handles.length) ui.render({ type: "spawnHistory", handles });
};

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
// A continuation travels here too, marked, so a user prompt can drop it.
private queue: QueuedPrompt[] = [];
private pending: ((turn: QueuedPrompt) => void) | null = null;
// True from the moment the loop takes a prompt until the turn it starts has
// closed. Without it a prompt taken out of the queue looks parked in
// nextPrompt(), and a child settling right then would start a second turn
// behind the one still running.
private turnInFlight = false;
// Batch of undelivered children the "I will wait for your prompt" notice was
// already shown for, so typing does not repeat it on every keystroke.
private noticedBatch = "";
// Automatic turns queued since the last prompt the user sent. It lives here
// because spending a budget is a policy of the loop, not a fact of the
// session, and it is deliberately not persisted: a restarted session starts
// with a fresh budget instead of inheriting the spend of a previous run, which
// would leave the user capped by turns they never saw.
private autoContinuations = 0;

constructor(options: MainLoopOptions = {}) {
this.config = options.config ?? new Config();
this.flows = createFlows([...SUPPORTED_PROVIDERS]);
this.commands = new CommandRepository();
this.ui = options.tui ? new TuiUiAdapter(this.config.config.ui?.theme) : new CliUiAdapter();
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

// A resumed session keeps the children of its previous runs on disk, so the
// strip starts with them; starting and settling produce pushed events, since
// the UI shows a child the moment it exists, even inside a turn.
showChildHistory(this.harness, this.ui);

this.harness.onSpawnEvent((event) => {
this.ui.render(
event.type === "started"
? { type: "spawn", handle: event.handle }
: { type: "spawnSettled", handle: event.handle },
);

// A child that settles while the session waits for a prompt can leave work
// the parent still owes: that turn starts on its own. A settle that lands
// mid-turn is not continued from here; the end of that turn judges it.
if (event.type === "settled") this.maybeContinue();
});

if (this.isTui()) {
// Ink owns stdin, so the app pushes prompts into the same loop.
(this.ui as TuiUiAdapter).start({
onSubmit: (prompt) => this.enqueueFromUser(prompt),
onExit: () => this.shutdown(0),
// The draft decides whether a continuation may start: the box reports every
// change, including the emptying that follows a send.
onDraftChange: () => this.maybeContinue({ fromDraft: true }),
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

// Hands a prompt to the loop waiting for one. The entry is built even on the
// direct hand-off: the turn it starts marks the batch it waits for, which is
// what tells its end that the work was delivered.
protected enqueue(
prompt: string,
kind: "user" | "continuation" = "user",
batch: QueuedPrompt["batch"] = undefined,
fromDraft = false,
) {
const entry: QueuedPrompt = {
text: prompt,
continuation: kind === "continuation",
...(fromDraft ? { fromDraft } : {}),
...(batch ? { batch } : {}),
};

if (this.pending) {
const resolve = this.pending;
this.pending = null;
resolve(entry);
return;
}
this.queue.push(entry);
// Only a queued continuation spends the budget: one handed straight to a
// parked loop never reaches the queue and starts its turn elsewhere.
if (entry.continuation) this.autoContinuations += 1;
}

// A prompt the user typed wins over the continuations still waiting: they
// would run the very work the user is asking for now.
protected enqueueFromUser(prompt: string) {
// Any prompt the user sends opens a new budget, whether it drops a
// continuation or arrives after the cap stopped the chain.
this.autoContinuations = 0;
// The send empties the input box, and that draft change may have queued a
// continuation a moment ago: it is the user prompt itself that supersedes it,
// so it goes with the ones already waiting.
if (dropContinuations(this.queue, this.queue.length) > 0) {
this.ui.render({ type: "notice", message: CONTINUATION_DROPPED_NOTICE });
}
this.enqueue(prompt);
}

// Starts a turn on its own when a child left work and the user is not
// holding the loop. Called from the only two points where that can become
// true: a child settling, and the end of a turn, because a settle that lands
// mid-turn (or behind an approval dialog) is only continuable once the turn
// that was running is over. Both go through here so the rule lives once.
//
// `userPrompt` marks the end of a turn the user asked for: their prompt
// supersedes any continuation still owed, and delivering the batch is all the
// work it needs.
protected maybeContinue(options: { userPrompt?: boolean; fromDraft?: boolean } = {}) {
const pending = this.harness.pendingSpawns();
const key = batchKey(pending);
// Another batch is another chance to announce we are waiting; an emptied
// one simply forgets the notice it had already given.
if (key !== this.noticedBatch) this.noticedBatch = "";

const decision = continuationDecision({
waitingForPrompt: this.isWaitingForPrompt(),
hasUserDraft: this.hasUserDraft(),
pending,
budget: { used: this.autoContinuations, max: this.maxAutoContinuations() },
userSentPrompt: options.userPrompt ?? false,
fromDraft: options.fromDraft ?? false,
});
// The queue is the truth about what will run next, so dropping from the
// verdict keeps the budget honest: a dropped continuation never runs.
if (decision.discard && dropContinuations(this.queue, this.queue.length) > 0) {
this.ui.render({ type: "notice", message: CONTINUATION_DROPPED_NOTICE });
}

if (decision.notice && this.noticedBatch !== key) {
this.noticedBatch = key;
this.ui.render({ type: "notice", message: decision.notice });
}
if (decision.continue) this.enqueue(CONTINUATION_PROMPT, "continuation", pending);
}

// The cap from the config, read on every decision so an edited value applies
// without restarting. Missing (unreachable past Config.applyDefaults) falls
// back to the same default rather than meaning "no cap".
protected maxAutoContinuations(): number | false {
return this.config.config.sessions?.maxAutoContinuations ?? 5;
}

// True when the loop is parked in nextPrompt() with nobody to hand a prompt
// to: the only moment a turn may start without the user asking for it. A turn
// already running is not waiting, even between taking its prompt and parking
// again.
protected isWaitingForPrompt(): boolean {
return !this.turnInFlight && this.pending !== null && this.queue.length === 0;
}

// Only the TUI knows whether the input box holds text the user has not sent;
// the line renderer reads stdin itself and has no draft to inspect.
protected hasUserDraft(): boolean {
const ui = this.ui as Partial<TuiUiAdapter>;

return this.isTui() && typeof ui.hasDraft === "function" && ui.hasDraft();
}

// Next prompt: from the TUI queue, or from stdin in line mode. A queued
// continuation is marked, so the turn it starts knows nobody asked for it.
protected async nextPrompt(): Promise<QueuedPrompt> {
// The line renderer reads stdin directly, so it has no queue to park a
// resolver in and no draft to respect: a continuation would have to steal a
// turn the user is about to type into. Continuations are TUI-only.
if (!this.isTui()) {
const text = await input("Type your prompt: ", { commands: this.commands.list() });

return { text, continuation: false };
}

const queued = this.queue.shift();
if (queued !== undefined) return queued;

return new Promise<QueuedPrompt>((resolve) => {
this.pending = resolve;
});
}

// Main prompt loop: reads, dispatches to the harness and renders output.
protected async loop() {
while (true) {
const turn = await this.nextPrompt();
const prompt = turn.text.trim();
if (!prompt) continue;

if (prompt.startsWith("/")) {
const before = this.harness.status().sessionId;
const handled = await this.commands.run(prompt, this.commandContext());
// A command can switch sessions (/resume, /switch): the strip must show
// the children of the session we are in now, not the previous one.
if (this.harness.status().sessionId !== before) {
showChildHistory(this.harness, this.ui);
}
if (!handled) {
this.ui.render({
type: "notice",
message: `Unknown command: ${prompt}. Type /help for a list.`,
});
}
continue;
}

this.ui.render({ type: "turnStart", prompt });
// From here until turnEnd the loop owes the user an answer: no child settling
// in between may start a turn of its own.
this.turnInFlight = true;
// A turn nobody asked for carries the batch it was queued for: delivering it
// is the work it owed.
const owed = turn.continuation ? (turn.batch ?? []) : [];
let userPrompt = !turn.continuation;

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
// A prompt the user sent while this turn ran was queued, not dropped: it
// supersedes the continuation and the work this turn delivered. Reading it
// before continuing keeps the same batch from being handed twice.
const queued = this.queue.find((entry) => !entry.continuation);
if (queued) userPrompt = true;
// Delivering the batch a continuation waited for is the continuation itself,
// so the same results are not continued a second time.
const delivered = batchKey(this.harness.pendingSpawns()) !== batchKey(owed);
for (const image of images ?? []) {
await this.ui.renderImage(image.url);
}
// The children that settled while this turn ran are judged now, with the
// loop free to take a prompt again and the turn no longer holding ask(). The
// prompt just taken is not in the queue, so the turn flag covers the window
// between taking it and asking.
this.maybeContinue({ userPrompt: userPrompt && delivered });
// A turn nobody asked for that queues another one goes on alone: its close
// says so instead of looking like a stopped process. The last turn of the
// chain (a completed one queues nothing) closes like any other turn.
this.ui.render({
type: "turnEnd",
text,
outcome,
continuation: turn.continuation && this.queue.some((entry) => entry.continuation),
});
// Only after the turn closed: anything settled before this point belongs to
// the turn that just ended.
this.turnInFlight = false;
this.printStatus();
} catch (err) {
this.turnInFlight = false;
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
