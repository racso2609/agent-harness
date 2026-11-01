import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, GLYPH, resolveTheme } from "../../src/ui/tui/theme";

describe("resolveTheme", () => {
it("returns the defaults when no theme is configured", () => {
expect(resolveTheme()).toEqual(DEFAULT_THEME);
});

it("merges a role override and keeps the rest", () => {
const theme = resolveTheme({ reasoning: { color: "magenta" } });

expect(theme.reasoning.color).toBe("magenta");
expect(theme.reasoning.dim).toBe(true);
expect(theme.user).toEqual(DEFAULT_THEME.user);
});

it("lets a role turn dim off", () => {
const theme = resolveTheme({ reasoning: { dim: false } });

expect(theme.reasoning.dim).toBe(false);
expect(theme.reasoning.color).toBe(DEFAULT_THEME.reasoning.color);
});

it("ignores unknown roles", () => {
const theme = resolveTheme({ bogus: { color: "red" } } as never);

expect(Object.keys(theme).sort()).toEqual(Object.keys(DEFAULT_THEME).sort());
});
});

describe("visual hierarchy", () => {
it("makes reasoning the dimmest and the answer the brightest", () => {
expect(DEFAULT_THEME.reasoning.dim).toBe(true);
expect(DEFAULT_THEME.notice.dim).toBe(true);
expect(DEFAULT_THEME.answer.dim).toBeUndefined();
expect(DEFAULT_THEME.answer.bold).toBe(true);
expect(DEFAULT_THEME.tool.dim).toBeUndefined();
});

it("gives every role a glyph except the answer", () => {
expect(GLYPH.answer).toBe("");
expect(GLYPH.user).not.toBe("");
expect(GLYPH.reasoning).not.toBe("");
expect(GLYPH.tool).not.toBe("");
});
});
