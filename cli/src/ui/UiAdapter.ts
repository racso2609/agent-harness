import type { ApprovalRequest, ConversationEntry, SpawnHandle, SpawnStatus } from "@racso/core";

// Session snapshot rendered in the status bar. Kept as a plain shape so the
// UI layer never imports the core session internals.
export interface UiStatus {
provider?: string;
model?: string;
agent?: string;
tokens?: number;
costUsd?: number;
// Session identity and context occupancy. The bar abbreviates the id; `/status`
// is the place that prints it whole.
sessionId?: string;
contextTokens?: number;
// Undefined when the provider does not publish one: the bar then omits the
// occupancy instead of inventing a percentage.
contextWindow?: number;
// 0..1
contextUsage?: number;
autoCompact?: boolean;
// Percentage at which core compacts the session.
autoCompactThreshold?: number;
}

// Everything the loop can show. The loop only speaks this vocabulary, so a
// renderer can be swapped (lines today, ink panels next) without touching it.
export type UiEvent =
| { type: "status"; status: UiStatus }
| { type: "notice"; message: string }
| { type: "reasoning"; delta: string }
| { type: "text"; delta: string }
// The authoritative final answer, after streaming (or instead of it).
| { type: "answer"; text: string }
| { type: "toolStart"; id: string; name: string }
| { type: "toolOutput"; id: string; name: string; chunk: string }
| { type: "toolEnd"; id: string; name: string }
| { type: "turnStart"; prompt: string }
| {
type: "turnEnd";
text?: string;
outcome?: { status: string; pending: string[]; next?: string };
// The turn was started by the loop, not by the user, and the loop
// already queued the next one: the session goes on alone. Optional,
// so a renderer that never receives it closes the turn as before.
continuation?: boolean;
}
| { type: "spawn"; handle: SpawnHandle }
// Children persisted in the session (previous runs). Sent once after loading,
// so a resumed session shows what it launched instead of an empty strip.
| { type: "spawnHistory"; handles: SpawnHandle[] }
| { type: "spawnSettled"; handle: SpawnHandle }
// The conversation of the session now in charge, oldest first. It replaces
// the transcript: a resumed session must not keep showing the messages of
// the one we left. Empty means the session has nothing to show.
| { type: "conversation"; entries: ConversationEntry[] }
| { type: "reset" };

export type SpawnSnapshot = { handle: SpawnHandle; status: SpawnStatus };

// One choice of a picker. `id` is what the caller gets back; `label` and `hint`
// are what a renderer paints, so a flow can pass an opaque id while the user
// reads something friendlier.
export interface SelectionOption {
id: string;
label: string;
hint?: string;
}

// A question expecting one line of text back. `secret` asks the renderer to
// hide what is typed: an API key must never reach the transcript, nor the
// scrollback a line renderer leaves on screen.
export interface TextRequest {
message: string;
// Explains what the answer is for, under the question. Optional because most
// questions are self-explanatory and the panel is precious vertical space.
hint?: string;
secret?: boolean;
}

// A yes/no question. It is not a `select` of two options because a select has
// no answer for a bare Enter, and the flows lean on that default to offer the
// safe choice without a keystroke.
export interface ConfirmRequest {
message: string;
hint?: string;
// What Enter answers. False when absent: a destructive confirmation must
// never be accepted by accident.
defaultAnswer?: boolean;
}

// A question with a list of answers. Every "/" flow that used to ask "which
// one?" goes through this asynchronously, so the same flow drives the ink
// picker and the numeric list of the line renderer.
export interface SelectionRequest {
message: string;
options: SelectionOption[];
}

// Rendering surface used by MainLoop. Implementations own the terminal; the
// loop never writes to stdout directly.
export interface UiAdapter {
render(event: UiEvent): void;
// Asks the user to approve a side-effect request.
promptApproval(request: ApprovalRequest): Promise<"allow" | "deny" | "always">;
// Asks the user to pick one option, resolving to its id, or to `undefined`
// when the user cancels. It is a UI concern and not a stdin read because the
// renderer owns the input stream: Ink pauses and consumes it, so a second
// listener would starve the TUI and read keystrokes meant for the app.
select(request: SelectionRequest): Promise<string | undefined>;
// Asks for one line of text, resolving to it, or to `undefined` when the user
// cancels. Same reason `select` lives here: the renderer owns the input
// stream, so a flow that read stdin itself would fight Ink for the keystrokes
// and paint its prompt outside the frame it draws.
promptText(request: TextRequest): Promise<string | undefined>;
// Asks a yes/no question, resolving to false for "no" and to `undefined` when
// the user cancels. Cancelling is not "no": a flow aborts on `undefined`
// instead of taking an answer the user never gave.
confirm(request: ConfirmRequest): Promise<boolean | undefined>;
// Renders a data-url image inline.
renderImage(url: string): Promise<void>;
// Restores the terminal before the process exits.
close(): void;
}
