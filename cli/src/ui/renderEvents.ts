import type { AgentResponse, ChatEvent, SessionUsage } from "@racso/core";
import type { UiAdapter, UiEvent, UiStatus } from "@/ui/UiAdapter";

// Shapes a core ChatEvent into the UI vocabulary. Kept pure so both renderers
// share exactly the same mapping.
export const toUiEvents = (event: ChatEvent): UiEvent[] => {
switch (event.type) {
case "text":
return [{ type: "text", delta: event.delta }];
case "reasoning":
return [{ type: "reasoning", delta: event.delta }];
case "toolCallStart":
return [{ type: "toolStart", id: event.id, name: event.name }];
case "toolCallEnd":
return [{ type: "toolEnd", id: event.id, name: event.name }];
case "toolOutput":
return [{ type: "toolOutput", id: event.id, name: event.name, chunk: event.chunk }];
}
};

// Snapshot the UI accepts in place of a core `SessionStatus`. It is a structural
// superset: core always sends `usage`, but the UI still takes partial snapshots
// (a session that has not run yet has no provider) and the flat `tokens` field
// that predates `usage`, so older callers and tests keep compiling.
export interface StatusSnapshot {
provider?: string;
model?: string;
agent?: string;
// Flat token count, the legacy form. Core reports counts as `usage.totalTokens`
// instead; both exist so this mapping is the only place that has to know it.
tokens?: number;
usage?: SessionUsage;
costUsd?: number;
sessionId?: string;
contextTokens?: number;
contextWindow?: number;
contextUsage?: number;
autoCompact?: boolean;
autoCompactThreshold?: number;
}

// The single place that says which core field becomes which UI field. Kept pure
// and separate from the event wrapper so the translation can be asserted
// directly: a wrong field name here used to degrade silently to `undefined`,
// because every UI status field is optional and the bar just dropped the part.
export const statusFromSession = (sessionStatus: StatusSnapshot): UiStatus => ({
provider: sessionStatus.provider,
model: sessionStatus.model,
agent: sessionStatus.agent,
// Core never sends `tokens`, so the flat field alone left the bar without a
// token count at all; `usage.totalTokens` is the form that actually arrives.
tokens: sessionStatus.tokens ?? sessionStatus.usage?.totalTokens,
costUsd: sessionStatus.costUsd,
sessionId: sessionStatus.sessionId,
contextTokens: sessionStatus.contextTokens,
contextWindow: sessionStatus.contextWindow,
contextUsage: sessionStatus.contextUsage,
autoCompact: sessionStatus.autoCompact,
autoCompactThreshold: sessionStatus.autoCompactThreshold,
});

// Builds the status event from a harness status snapshot.
export const toStatusEvent = (status: StatusSnapshot): UiEvent => ({
type: "status",
status: statusFromSession(status),
});

export type { AgentResponse, UiAdapter };
