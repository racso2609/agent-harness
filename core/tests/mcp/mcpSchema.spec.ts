import { describe, expect, it } from "vitest";
import { normalizeInputSchema, truncateDescription } from "../../src/mcp/mcpSchema";

describe("normalizeInputSchema", () => {
  it("keeps a valid object schema with properties and required", () => {
    const raw = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limit: { type: "integer" },
      },
      required: ["query"],
    };

    const schema = normalizeInputSchema(raw);

    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });
  });

  it("drops keys the harness schema does not model", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      title: "SearchInput",
      $id: "#search",
      "x-vendor": true,
    });

    expect(schema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  it("returns an empty schema for non-object input", () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema(null)).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema("nope")).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema([])).toEqual({ type: "object", properties: {} });
  });

  it("returns an empty schema when the root type is not object", () => {
    expect(normalizeInputSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("returns an empty schema when properties is missing or not an object", () => {
    expect(normalizeInputSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
    expect(normalizeInputSchema({ type: "object", properties: "bad" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("degrades root $ref, anyOf and oneOf to the empty schema", () => {
    expect(normalizeInputSchema({ $ref: "#/definitions/Search" })).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeInputSchema({ anyOf: [{ type: "object", properties: {} }] })).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeInputSchema({ oneOf: [{ type: "object", properties: {} }] })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("filters non-string entries out of required", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", 2, null, { x: 1 }, "b", ""],
    });

    expect(schema.required).toEqual(["a", "b"]);
  });

  it("omits required when nothing usable is left", () => {
    const schema = normalizeInputSchema({ type: "object", properties: {}, required: [1, false] });

    expect(schema).toEqual({ type: "object", properties: {} });
  });

  it("filters property entries that are not plain objects", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {
        a: 42,
        b: null,
        c: [],
        d: "string",
        ok: { type: "string" },
      },
    });

    expect(schema.properties).toEqual({ ok: { type: "string" } });
  });

  it("keeps only the modelled property keys", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "Text", enum: ["a", "b"], default: "a", title: "Q" },
      },
    });

    expect(schema.properties).toEqual({
      query: { type: "string", description: "Text", enum: ["a", "b"], default: "a" },
    });
  });

  it("degrades an items $ref to an empty schema object", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: { tags: { type: "array", items: { $ref: "#/x" } } },
    });

    expect(schema.properties).toEqual({ tags: { type: "array", items: {} } });
  });

  it("sanitizes nested properties", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { name: { type: "string", "x-vendor": true }, bad: 1 },
        },
      },
    });

    expect(schema.properties).toEqual({
      filter: { type: "object", properties: { name: { type: "string" } } },
    });
  });

  it("drops a property type the harness cannot represent", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {
        odd: { type: "weird", description: "Kept anyway" },
        list: { type: ["string", "null"] },
        numeric: { type: 42 },
      },
    });

    expect(schema.properties).toEqual({
      odd: { description: "Kept anyway" },
      list: {},
      numeric: {},
    });
  });

  it("keeps every type the harness models", () => {
    const types = ["string", "number", "integer", "boolean", "array", "object"];
    const schema = normalizeInputSchema({
      type: "object",
      properties: Object.fromEntries(types.map((type) => [type, { type }])),
    });

    expect(schema.properties).toEqual(Object.fromEntries(types.map((type) => [type, { type }])));
  });

  it("drops a nested property type the harness cannot represent", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {
        filter: { type: "object", properties: { name: { type: "weird" } } },
      },
    });

    expect(schema.properties).toEqual({ filter: { type: "object", properties: { name: {} } } });
  });

  it("does not mutate nested property entries", () => {
    const raw = {
      type: "object",
      properties: { tags: { type: "array", items: { $ref: "#/x", title: "T" }, title: "Tags" } },
    };
    const snapshot = JSON.parse(JSON.stringify(raw));

    normalizeInputSchema(raw);

    expect(raw).toEqual(snapshot);
  });

  it("drops required entries that are not declared properties", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: {},
      required: ["ghost"],
    });

    expect(schema).toEqual({ type: "object", properties: {} });
    expect(schema.required).toBeUndefined();
  });

  it("keeps only the declared entries of a mixed required list", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query", "ghost"],
    });

    expect(schema.required).toEqual(["query"]);
  });

  it("filters required against the properties that survived sanitizing", () => {
    const schema = normalizeInputSchema({
      type: "object",
      properties: { query: { type: "string" }, dropped: 42 },
      required: ["query", "dropped"],
    });

    expect(schema.required).toEqual(["query"]);
  });

  it("does not mutate the input", () => {
    const raw = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", 7],
      extra: "ignored",
    };
    const snapshot = JSON.parse(JSON.stringify(raw));

    normalizeInputSchema(raw);

    expect(raw).toEqual(snapshot);
    expect(raw.required).toEqual(["a", 7]);
  });
});

describe("truncateDescription", () => {
  it("returns short text unchanged", () => {
    expect(truncateDescription("List issues", 300)).toBe("List issues");
    expect(truncateDescription("exactly10!", 10)).toBe("exactly10!");
  });

  it("truncates long text and marks the cut with an ellipsis", () => {
    const text = "a".repeat(50);
    const result = truncateDescription(text, 10);

    expect(result.length).toBe(10);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toBe(`${"a".repeat(9)}…`);
  });

  it("returns an empty string for missing or empty text", () => {
    expect(truncateDescription(undefined, 300)).toBe("");
    expect(truncateDescription("", 300)).toBe("");
  });
});
