import { describe, expect, it } from "vitest";
import { toStatusEvent, toUiEvents } from "../../src/ui/renderEvents";

describe("toUiEvents", () => {
it("maps text deltas", () => {
expect(toUiEvents({ type: "text", delta: "hi" })).toEqual([
{ type: "text", delta: "hi" },
]);
});

it("maps reasoning deltas", () => {
expect(toUiEvents({ type: "reasoning", delta: "why" })).toEqual([
{ type: "reasoning", delta: "why" },
]);
});

it("maps tool lifecycle events", () => {
expect(toUiEvents({ type: "toolCallStart", id: "c1", name: "shell" })).toEqual([
{ type: "toolStart", id: "c1", name: "shell" },
]);
expect(toUiEvents({ type: "toolCallEnd", id: "c1", name: "shell" })).toEqual([
{ type: "toolEnd", id: "c1", name: "shell" },
]);
});

it("maps live tool output with its originating call", () => {
expect(
toUiEvents({ type: "toolOutput", id: "c1", name: "shell", chunk: "out" }),
).toEqual([{ type: "toolOutput", id: "c1", name: "shell", chunk: "out" }]);
});
});

describe("toStatusEvent", () => {
it("wraps the status snapshot into a status event", () => {
const event = toStatusEvent({
provider: "openai",
model: "gpt",
agent: "default",
tokens: 12,
costUsd: 0.5,
});

expect(event).toEqual({
type: "status",
status: {
provider: "openai",
model: "gpt",
agent: "default",
tokens: 12,
costUsd: 0.5,
},
});
});

it("keeps missing fields undefined", () => {
const event = toStatusEvent({});

expect(event.type).toBe("status");
expect(event.status.provider).toBeUndefined();
});
});
