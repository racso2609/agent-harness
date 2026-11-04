import type { AgentResponse, ChatEvent } from "@racso/core";
import type { UiAdapter, UiEvent } from "@/ui/UiAdapter";

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

// Builds the status event from a harness status snapshot.
//
// The snapshot is a core `SessionStatus`, but it is taken as a structural shape
// so the UI mapping still accepts partial snapshots (a session that has not run
// yet has no provider) and the UI layer keeps its own vocabulary.
export const toStatusEvent = (status: {
provider?: string;
model?: string;
agent?: string;
tokens?: number;
costUsd?: number;
sessionId?: string;
contextTokens?: number;
contextWindow?: number;
contextUsage?: number;
autoCompact?: boolean;
autoCompactThreshold?: number;
}): UiEvent => ({
type: "status",
status: {
provider: status.provider,
model: status.model,
agent: status.agent,
tokens: status.tokens,
costUsd: status.costUsd,
sessionId: status.sessionId,
contextTokens: status.contextTokens,
contextWindow: status.contextWindow,
contextUsage: status.contextUsage,
autoCompact: status.autoCompact,
autoCompactThreshold: status.autoCompactThreshold,
},
});

export type { AgentResponse, UiAdapter };
