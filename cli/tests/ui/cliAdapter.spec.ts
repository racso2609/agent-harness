import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnHandle } from "@racso/core";
import type { UiEvent } from "../../src/ui/UiAdapter";

// The line renderer writes straight to the terminal: every notice goes through
// process.stdout.write, and @/terminal/stdin repaints the prompt around it. A
// headless run has no TTY, so the prompt helpers would be no-ops anyway, but
// their reads of process.stdout would still be real calls. Both are stubbed so
// the tests only see what the adapter itself decided to print.
vi.mock("../../src/terminal/stdin", () => ({
clearPrompt: vi.fn(),
restorePrompt: vi.fn(),
printLogo: vi.fn(),
printImage: vi.fn(),
input: vi.fn(),
}));

const { CliUiAdapter } = await import("../../src/ui/CliUiAdapter");
const { formatSpawnOutcome, formatTurnOutcome } = await import(
"../../src/ui/outcome"
);

const settled = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
spawnId: "spawn-1",
sessionId: "session-1",
agentId: "coder",
prompt: "implement",
status: "done",
startedAt: new Date(0).toISOString(),
...overrides,
});

// Everything the adapter printed during one or more events, as one string.
const printed = (events: UiEvent[]): string => {
const ui = new CliUiAdapter();
const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

try {
for (const event of events) ui.render(event);

return stdout.mock.calls.map((call) => String(call[0])).join("");
} finally {
stdout.mockRestore();
}
};

afterEach(() => {
vi.restoreAllMocks();
});

// The default renderer is what most sessions actually see, so its two closing
// notices are pinned against the shared formatters: if either side changes
// what the user reads, the test says so.
describe("the line renderer", () => {
describe("settling a child", () => {
it("reports the result of a child that finished", () => {
const handle = settled({ result: "all tests pass" });
const output = printed([{ type: "spawnSettled", handle }]);

expect(output).toContain(formatSpawnOutcome(handle));
expect(output).toContain("all tests pass");
});

it("reports the error of a child that failed", () => {
const handle = settled({ status: "error", error: "provider down" });
const output = printed([{ type: "spawnSettled", handle }]);

expect(output).toContain(formatSpawnOutcome(handle));
expect(output).toContain("provider down");
});

it("says (no output) instead of a header with an empty body", () => {
const handle = settled({ result: "" });
const output = printed([{ type: "spawnSettled", handle }]);
const line = output.trim();

expect(line).toContain("(no output)");
// No dangling separator: the line has a body, not just a colon.
expect(line.endsWith(":")).toBe(false);
expect(line.endsWith("(no output)")).toBe(true);
});
});

describe("closing a turn", () => {
it("reports the status, the pending work and the next step", () => {
const outcome = {
status: "toolError",
pending: ["shell"],
next: "retry",
};
const output = printed([{ type: "turnEnd", outcome }]);

expect(output).toContain(formatTurnOutcome(outcome));
expect(output).toContain("turn failed");
expect(output).toContain("pending: shell");
expect(output).toContain("next: retry");
});

it("says nothing when the turn completed", () => {
const output = printed([
{ type: "turnEnd", outcome: { status: "completed", pending: [] } },
]);

expect(output).toBe("");
expect(output).not.toContain("turn failed");
expect(output).not.toContain("turn incomplete");
expect(output).not.toContain("pending:");
});

it("says nothing when the turn carries no outcome", () => {
const output = printed([{ type: "turnEnd" }]);

expect(output).toBe("");
});
});
});
