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

    expect(doc.blocks).toEqual([{ kind: "code", language: "ts", lines: ["const a = 1;"] }]);
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

    expect(doc.blocks).toEqual([{ kind: "code", language: "js", lines: ["let a = 1;"] }]);
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

    expect(doc.blocks).toEqual([{ kind: "code", language: undefined, lines: ["first", "last"] }]);
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

describe("tables", () => {
  const table = ["| name | qty |", "| :--- | ---: |", "| apple | 3 |", "| pear | 12 |"];

  it("parses a table with alignment from the separator row", () => {
    const block = parseBlock(table.join("\n"));

    expect(block).toEqual({
      kind: "table",
      header: [[{ text: "name" }], [{ text: "qty" }]],
      align: ["left", "right"],
      rows: [
        [[{ text: "apple" }], [{ text: "3" }]],
        [[{ text: "pear" }], [{ text: "12" }]],
      ],
    });
  });

  it("supports center alignment and missing outer pipes", () => {
    const block = parseBlock("a | b\n:---: | ---\n1 | 2");

    expect(block?.kind).toBe("table");
    expect((block as { align: string[] }).align).toEqual(["center", "left"]);
  });

  it("pads short rows to the header width", () => {
    const block = parseBlock("| a | b |\n| --- | --- |\n| 1 |");

    expect((block as { rows: unknown[][][] }).rows).toEqual([[[{ text: "1" }], []]]);
  });

  it("keeps a streamed table in one block", () => {
    const stream = new MarkdownStream();
    const doc = stream.push(`${table.join("\n")}\nafter`);

    // The table closes as soon as a non-row line arrives; the trailing text is
    // still streaming, so it stays open until finish().
    expect(doc.blocks.map((block) => block.kind)).toEqual(["table"]);
    expect(doc.open).toBe("after");
    expect(stream.finish().blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
  });

  it("does not mistake a pipe inside a paragraph for a table", () => {
    expect(parseBlock("a | b is just text")).toEqual({
      kind: "paragraph",
      spans: [{ text: "a | b is just text" }],
    });
  });
});

describe("lists", () => {
  it("keeps ordinal numbers", () => {
    const block = parseBlock("1. first\n2. second");

    expect(block?.kind).toBe("list");
    expect((block as { ordered: boolean }).ordered).toBe(true);
    expect((block as { items: { marker: string }[] }).items.map((i) => i.marker)).toEqual([
      "1.",
      "2.",
    ]);
  });

  it("keeps nesting depth from indentation", () => {
    const block = parseBlock("- top\n  - nested\n    - deeper");

    const items = (block as { items: { depth: number }[] }).items;
    expect(items.map((item) => item.depth)).toEqual([0, 1, 2]);
  });

  it("uses bullets for unordered lists", () => {
    const block = parseBlock("- a\n- b");

    expect((block as { items: { marker: string }[] }).items[0]?.marker).toBe("-");
  });
});
