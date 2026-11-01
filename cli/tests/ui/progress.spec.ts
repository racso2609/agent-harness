import { describe, expect, it } from "vitest";
import {
colorFor,
elapsedFor,
iconFor,
SPAWN_LINGER_MS,
visibleSpawns,
} from "../../src/ui/tui/progress";

const at = (offsetMs: number) => new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();
const now = Date.parse(at(60_000));

describe("visibleSpawns", () => {
it("shows a running child even without timing data", () => {
const spawns = [{ id: "s1", agent: "coder", status: "running" }];

expect(visibleSpawns(spawns, now)).toHaveLength(1);
});

it("keeps a settled child during the linger window", () => {
const spawns = [
{
id: "s1",
agent: "coder",
status: "done",
startedAt: at(0),
finishedAt: at(58_000),
},
];

expect(visibleSpawns(spawns, now)).toHaveLength(1);
});

it("drops a settled child once the linger window passes", () => {
const spawns = [
{
id: "s1",
agent: "coder",
status: "done",
startedAt: at(0),
finishedAt: new Date(now - SPAWN_LINGER_MS - 1_000).toISOString(),
},
];

expect(visibleSpawns(spawns, now)).toHaveLength(0);
});

it("keeps running children when others have expired", () => {
const spawns = [
{ id: "old", agent: "a", status: "done", startedAt: at(0), finishedAt: at(1_000) },
{ id: "live", agent: "b", status: "running", startedAt: at(50_000) },
];

expect(visibleSpawns(spawns, now).map((s) => s.id)).toEqual(["live"]);
});
});

describe("elapsedFor", () => {
it("counts up while running", () => {
const spawn = { id: "s", agent: "a", status: "running", startedAt: at(45_000) };

expect(elapsedFor(spawn, now)).toBe("15s");
});

it("freezes once settled", () => {
const spawn = {
id: "s",
agent: "a",
status: "done",
startedAt: at(0),
finishedAt: at(42_000),
};

expect(elapsedFor(spawn, now)).toBe("done in 42s");
});

it("falls back to the status when there is no start time", () => {
expect(elapsedFor({ id: "s", agent: "a", status: "error" }, now)).toBe("error");
});
});

describe("iconFor / colorFor", () => {
it("maps each lifecycle state", () => {
expect(iconFor("running")).toBe("◐");
expect(iconFor("done")).toBe("✓");
expect(iconFor("error")).toBe("✗");

expect(colorFor("running")).toBe("cyan");
expect(colorFor("done")).toBe("green");
expect(colorFor("error")).toBe("red");
});
});
