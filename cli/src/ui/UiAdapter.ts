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
// Renders a data-url image inline.
renderImage(url: string): Promise<void>;
// Restores the terminal before the process exits.
close(): void;
}
