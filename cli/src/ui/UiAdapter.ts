import type { ApprovalRequest, SpawnHandle, SpawnStatus } from "@racso/core";

// Session snapshot rendered in the status bar. Kept as a plain shape so the
// UI layer never imports the core session internals.
export interface UiStatus {
provider?: string;
model?: string;
agent?: string;
tokens?: number;
costUsd?: number;
}

// Everything the loop can show. The loop only speaks this vocabulary, so a
// renderer can be swapped (lines today, ink panels next) without touching it.
export type UiEvent =
| { type: "status"; status: UiStatus }
| { type: "notice"; message: string }
| { type: "reasoning"; delta: string }
| { type: "text"; delta: string }
| { type: "toolStart"; id: string; name: string }
| { type: "toolOutput"; id: string; name: string; chunk: string }
| { type: "toolEnd"; id: string; name: string }
| { type: "turnStart"; prompt: string }
| {
type: "turnEnd";
text?: string;
outcome?: { status: string; pending: string[]; next?: string };
}
| { type: "spawn"; handle: SpawnHandle }
| { type: "spawnSettled"; handle: SpawnHandle }
| { type: "reset" };

export type SpawnSnapshot = { handle: SpawnHandle; status: SpawnStatus };

// Rendering surface used by MainLoop. Implementations own the terminal; the
// loop never writes to stdout directly.
export interface UiAdapter {
render(event: UiEvent): void;
// Asks the user to approve a side-effect request.
promptApproval(request: ApprovalRequest): Promise<"allow" | "deny" | "always">;
// Renders a data-url image inline.
renderImage(url: string): Promise<void>;
// Restores the terminal before the process exits.
close(): void;
}

