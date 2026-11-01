import { describe, expect, it } from "vitest";
import { MarkdownStream, parseBlock, parseInline } from "../../src/ui/tui/markdown";

describe("parseInline", () => {
it("keeps plain text as a single span", () => {
expect(parseInline("hello")).toEqual([{ text: "hello" }]);
});

it("styles bold, italic and code", () => {
expect(parseInline("a **b** c")).toEqual([
{ text: "a " },
{ text: "b", bold: true },
{ text: " c" },
]);
expect(parseInline("a `code` b")).toEqual([
{ text: "a " },
{ text: "code", code: true },
{ text: " b" },
]);
expect(parseInline("a *it* b")).toEqual([
{ text: "a " },
{ text: "it", italic: true },
{ text: " b" },
]);
});

it("does not treat markers inside code as formatting", () => {
expect(parseInline("`**raw**`")).toEqual([{ text: "**raw**", code: true }]);
});
});

describe("parseBlock", () => {
it("parses a heading with its level", () => {
const block = parseBlock("## Title");

expect(block).toEqual({ kind: "heading", level: 2, spans: [{ text: "Title" }] });
});

it("parses a list", () => {
const block = parseBlock("- one\n- two");

expect(block?.kind).toBe("list");
});

it("parses a quote and a rule", () => {
expect(parseBlock("> note")).toEqual({ kind: "quote", spans: [{ text: "note" }] });
expect(parseBlock("---")).toEqual({ kind: "rule" });
});

it("returns null for blank input", () => {
expect(parseBlock("   ")).toBeNull();
});
});

describe("MarkdownStream", () => {
it("keeps an unfinished bold marker out of the closed blocks", () => {
const stream = new MarkdownStream();
const doc = stream.push("hello **wor");

expect(doc.blocks).toEqual([]);
expect(doc.open).toBe("hello **wor");
});

it("closes a paragraph when a blank line arrives", () => {
const stream = new MarkdownStream();
const doc = stream.push("hello **world**\n\nnext");

expect(doc.blocks).toEqual([
{ kind: "paragraph", spans: [{ text: "hello " }, { text: "world", bold: true }] },
]);
expect(doc.open).toBe("next");
});

it("collects a fenced code block without styling its content", () => {
const stream = new MarkdownStream();
const doc = stream.push("```ts\nconst a = 1;\n```\nafter");

expect(doc.blocks).toEqual([
{ kind: "code", language: "ts", lines: ["const a = 1;"] },
]);
expect(doc.open).toBe("after");
});

it("shows the open code block as plain text while it streams", () => {
const stream = new MarkdownStream();
const doc = stream.push("```\nline 1\nline 2");

expect(doc.blocks).toEqual([]);
expect(doc.open).toBe("line 1\nline 2");
});

it("finishes everything still open", () => {
const stream = new MarkdownStream();
stream.push("```js\nlet a = 1;");
const doc = stream.finish();

expect(doc.blocks).toEqual([
{ kind: "code", language: "js", lines: ["let a = 1;"] },
]);
expect(doc.open).toBe("");
});

it("accumulates deltas across many small pushes", () => {
const stream = new MarkdownStream();
const text = "# Title\n\nsome **bold** text\n\n- a\n- b";

for (const char of text) stream.push(char);
const doc = stream.finish();

const kinds = doc.blocks.map((block) => block.kind);
expect(kinds).toContain("heading");
expect(kinds).toContain("paragraph");
expect(kinds).toContain("list");
});
});

describe("MarkdownStream without a trailing newline", () => {
it("shows the last line of an open fence", () => {
const stream = new MarkdownStream();
const doc = stream.push("```\nfirst\nlast");

expect(doc.open).toBe("first\nlast");
});

it("closes a fence whose final line has no newline", () => {
const stream = new MarkdownStream();
stream.push("```\nfirst\nlast");
const doc = stream.finish();

expect(doc.blocks).toEqual([
{ kind: "code", language: undefined, lines: ["first", "last"] },
]);
});

it("closes a paragraph that never got a blank line", () => {
const stream = new MarkdownStream();
stream.push("just **text**");
const doc = stream.finish();

expect(doc.blocks).toEqual([
{ kind: "paragraph", spans: [{ text: "just " }, { text: "text", bold: true }] },
]);
});
});
