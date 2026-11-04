import { describe, expect, it } from "vitest";
import type { UiStatus } from "../../src/ui/UiAdapter";
import { abbreviateSession, formatCompactTokens, formatStatusBar } from "../../src/ui/statusBar";

const full: UiStatus = {
sessionId: "65ee2a6f-1a2b-4c3d-9e8f-001122334455",
provider: "openai",
model: "gpt-test",
agent: "default",
tokens: 15900,
costUsd: 0.0042,
contextTokens: 51200,
contextWindow: 128000,
contextUsage: 0.4,
autoCompact: true,
autoCompactThreshold: 60,
};

describe("abbreviateSession", () => {
it("keeps the first eight characters", () => {
expect(abbreviateSession("65ee2a6f-1a2b-4c3d")).toBe("65ee2a6f");
});

it("keeps short ids whole", () => {
expect(abbreviateSession("abc")).toBe("abc");
});
});

describe("formatCompactTokens", () => {
it("leaves counts under a thousand alone", () => {
expect(formatCompactTokens(999)).toBe("999");
});

it("keeps one decimal for odd counts", () => {
expect(formatCompactTokens(12345)).toBe("12k");
expect(formatCompactTokens(1234)).toBe("1.2k");
});

it("drops a zero decimal", () => {
expect(formatCompactTokens(2000)).toBe("2k");
});

it("rounds past ten thousand", () => {
expect(formatCompactTokens(15900)).toBe("16k");
expect(formatCompactTokens(128000)).toBe("128k");
});

it("switches to millions", () => {
expect(formatCompactTokens(1_500_000)).toBe("1.5M");
});
});

describe("formatStatusBar", () => {
it("renders every part on one line", () => {
expect(formatStatusBar(full)).toBe(
"ses 65ee2a6f · openai/gpt-test · default · 16k tok · $0.0042 · ctx 40% 51k/128k",
);
});

it("returns an empty line when there is nothing to show", () => {
expect(formatStatusBar({})).toBe("");
});

it("omits the occupancy when the window is unknown", () => {
const line = formatStatusBar({ ...full, contextWindow: undefined });

expect(line).toContain("ctx 40%");
expect(line).not.toContain("51k");
});

it("omits the context part when no usage was reported", () => {
const line = formatStatusBar({ ...full, contextUsage: undefined });

expect(line).not.toContain("ctx");
});

it("marks auto-compact once the threshold is crossed", () => {
expect(formatStatusBar({ ...full, contextUsage: 0.72 })).toContain("auto-compact @60%");
});

it("stays quiet about auto-compact below the threshold", () => {
expect(formatStatusBar(full)).not.toContain("auto-compact");
});

it("stays quiet when auto-compact is off", () => {
const line = formatStatusBar({ ...full, contextUsage: 0.72, autoCompact: false });

expect(line).not.toContain("auto-compact");
});
});
