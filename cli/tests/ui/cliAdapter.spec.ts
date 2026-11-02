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
// notices are pinned to the literal text the user reads: each assertion spells
// out the whole line, ending in the newline notify adds. This way a change in
// the renderer, or in the pure formatters it delegates to, turns the test red.
// The formatters' own contract is covered by outcome.spec.ts.
describe("the line renderer", () => {
describe("settling a child", () => {
it("reports the result of a child that finished", () => {
const output = printed([
{ type: "spawnSettled", handle: settled({ result: "all tests pass" }) },
]);

expect(output).toBe("spawn spawn-1 done (coder): all tests pass\n");
});

it("reports the error of a child that failed", () => {
const output = printed([
{
type: "spawnSettled",
handle: settled({ status: "error", error: "provider down" }),
},
]);

expect(output).toBe("spawn spawn-1 error (coder): provider down\n");
});

it("says (no output) instead of a header with an empty body", () => {
const output = printed([
{ type: "spawnSettled", handle: settled({ result: "" }) },
]);

expect(output).toBe("spawn spawn-1 done (coder): (no output)\n");
});
});

describe("closing a turn", () => {
it("reports the status, the pending work and the next step", () => {
const output = printed([
{
type: "turnEnd",
outcome: { status: "toolError", pending: ["shell"], next: "retry" },
},
]);

expect(output).toBe("turn failed · pending: shell · next: retry\n");
});

it("says nothing when the turn completed", () => {
const output = printed([
{ type: "turnEnd", outcome: { status: "completed", pending: [] } },
]);

expect(output).toBe("");
});

it("says nothing when the turn carries no outcome", () => {
const output = printed([{ type: "turnEnd" }]);

expect(output).toBe("");
});
});
});
