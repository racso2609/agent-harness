// Naming rules for tools exposed by MCP servers. Every remote tool becomes
// `mcp__<server>__<tool>` so it can never collide with a native tool name,
// and the parts are sanitized to a character set the model and the OpenAI
// function-calling schema accept.
export const MCP_PREFIX = "mcp__";

// Matched against the composite name. The server id is greedy and the tool
// name non-greedy, so an id that itself contains `__` (sanitized ids keep
// their inner runs of `_`) is recovered whole and only the last `__` splits.
//
// INVARIANT, load-bearing for the parse direction: this pattern is only
// unambiguous because `sanitizeRemoteToolName` collapses runs of `_`. If a
// sanitized tool name could contain `__`, the greedy server id would swallow
// part of it and `parseMcpToolName` would return the wrong split. Removing that
// collapse breaks round-tripping even though the other tests still pass.
//
// INVARIANT, load-bearing for the parse direction: this pattern is only
// unambiguous because `sanitizeRemoteToolName` collapses runs of `_`. If a
// sanitized tool name could contain `__`, a greedy id would swallow part of it
// and `parseMcpToolName` would return the wrong split. Removing that collapse
// breaks round-tripping even though every other test still passes.
const MCP_TOOL_PATTERN = /^mcp__([a-z0-9_]+)__([a-z0-9_]+?)$/;

// Lowercases and replaces every run of characters outside [a-z0-9_] with `_`.
// Tolerates missing parts: configs come from user JSON, so a non-string
// becomes an empty string instead of throwing.
const toSafeChars = (text: string | undefined): string =>
  typeof text === "string" ? text.toLowerCase().replace(/[^a-z0-9_]+/g, "_") : "";

// Server ids appear inside the tool name, so they are reduced to [a-z0-9_].
// Only separators at the edges are dropped: runs of `_` inside the id are
// kept, so ids that are already safe keep their identity (`a__b` and `a_b`
// must not collapse into the same server).
export const sanitizeServerId = (id: string | undefined): string =>
  toSafeChars(id).replace(/^_+|_+$/g, "");

// Remote tool names additionally collapse runs of `_` (so `a__b` becomes
// `a_b`), otherwise a `b` tool of server `a` and an `a__b` native name would
// produce the same composite name.
export const sanitizeRemoteToolName = (name: string | undefined): string =>
  toSafeChars(name)
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

// Builds the harness-visible name of a remote tool. Returns undefined when
// either part sanitizes to nothing, because `mcp____tool` could never be
// parsed back by `parseMcpToolName`.
export const mcpToolName = (
  serverId: string | undefined,
  remoteToolName: string | undefined,
): string | undefined => {
  const server = sanitizeServerId(serverId);
  const tool = sanitizeRemoteToolName(remoteToolName);
  if (!server || !tool) return undefined;

  return `${MCP_PREFIX}${server}__${tool}`;
};

// True when the name follows the `mcp__<server>__<tool>` shape.
export const isMcpToolName = (name: string): boolean => MCP_TOOL_PATTERN.test(name);

// Splits a harness-visible name back into its sanitized parts. Returns
// undefined for anything that is not an MCP tool name.
export const parseMcpToolName = (
  name: string,
): { serverId: string; toolName: string } | undefined => {
  const match = MCP_TOOL_PATTERN.exec(name);
  if (!match) return undefined;

  return { serverId: match[1], toolName: match[2] };
};
