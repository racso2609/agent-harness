import type { JsonSchema, JsonSchemaProperty } from "@/types/providers";

const emptySchema = (): JsonSchema => ({ type: "object", properties: {} });

// The JSON Schema types the harness can represent. A server that declares
// anything else ("weird", an array of types) would make the provider reject
// the whole request, so the key is dropped instead.
const JSON_SCHEMA_TYPES = new Set<string>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

// True for a plain object: not null, not an array.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keeps only the property keys the harness JsonSchema models, recursing into
// `items` and nested `properties`. Anything else (`$ref`, `anyOf`, vendor
// keys) is dropped, because the harness schema cannot represent it and
// forwarding it makes providers reject the request.
const sanitizeProperty = (value: unknown): JsonSchemaProperty | undefined => {
  if (!isPlainObject(value)) return undefined;

  const property: JsonSchemaProperty = {};
  if (typeof value.type === "string" && JSON_SCHEMA_TYPES.has(value.type)) {
    property.type = value.type as JsonSchemaProperty["type"];
  }
  if (typeof value.description === "string") property.description = value.description;
  if (Array.isArray(value.enum)) {
    // Providers only accept scalar enum entries; objects and arrays would be
    // forwarded verbatim and rejected on the wire.
    const entries = value.enum.filter(
      (entry): entry is string | number | boolean =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
    );
    if (entries.length > 0) property.enum = entries;
  }
  if ("default" in value) property.default = value.default;

  if (isPlainObject(value.items)) {
    const items = sanitizeProperty(value.items);
    if (items) property.items = items;
  }

  if (isPlainObject(value.properties)) {
    const nested: Record<string, JsonSchemaProperty> = {};
    for (const [key, entry] of Object.entries(value.properties)) {
      const sanitized = sanitizeProperty(entry);
      if (sanitized) nested[key] = sanitized;
    }
    property.properties = nested;
  }

  return property;
};

// Normalizes the input schema advertised by an MCP server to the harness
// JsonSchema type. Only a flat object schema survives: `$ref`, `anyOf` and
// `oneOf` at the root degrade to the empty schema, because remote tools
// usually declare plain properties and the model is free to send whatever
// arguments the remote handler actually understands.
// Properties that are not plain objects are dropped, `required` is reduced to
// the properties that survived, and unknown keys are discarded.
// Never throws and never mutates `raw`.
export const normalizeInputSchema = (raw: unknown): JsonSchema => {
  if (!isPlainObject(raw)) return emptySchema();
  if (raw.type !== "object") return emptySchema();

  const declared = raw.properties;
  if (!isPlainObject(declared)) return emptySchema();

  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [key, value] of Object.entries(declared)) {
    const sanitized = sanitizeProperty(value);
    if (sanitized) properties[key] = sanitized;
  }

  const schema: JsonSchema = { type: "object", properties };

  if (Array.isArray(raw.required)) {
    // OpenAI and DeepSeek reject a `required` entry that is not a declared
    // property, so a stale server schema must not leak a ghost name.
    const known = new Set(Object.keys(properties));
    const required = raw.required.filter(
      (entry): entry is string => typeof entry === "string" && known.has(entry),
    );
    if (required.length > 0) schema.required = required;
  }

  if (typeof raw.additionalProperties === "boolean") {
    schema.additionalProperties = raw.additionalProperties;
  }

  return schema;
};

// Truncates a description to `maxChars`, marking the cut with an ellipsis.
export const truncateDescription = (text: string | undefined, maxChars: number): string => {
  if (!text || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  return `${text.slice(0, maxChars - 1)}…`;
};
