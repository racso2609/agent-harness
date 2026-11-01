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
return [
{ type: "toolOutput", id: event.id, name: event.name, chunk: event.chunk },
];
}
};

// Builds the status event from a harness status snapshot.
export const toStatusEvent = (status: {
provider?: string;
model?: string;
agent?: string;
tokens?: number;
costUsd?: number;
}): UiEvent => ({
type: "status",
status: {
provider: status.provider,
model: status.model,
agent: status.agent,
tokens: status.tokens,
costUsd: status.costUsd,
},
});

export type { AgentResponse, UiAdapter };
