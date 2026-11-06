import { describe, expect, it } from "vitest";
import {
  isMcpToolName,
  mcpToolName,
  parseMcpToolName,
  sanitizeRemoteToolName,
  sanitizeServerId,
} from "../../src/mcp/mcpNaming";

describe("sanitizeServerId", () => {
  it("keeps plain lowercase ids untouched", () => {
    expect(sanitizeServerId("github")).toBe("github");
    expect(sanitizeServerId("files_2")).toBe("files_2");
  });

  it("lowercases and replaces unsafe characters with a single underscore", () => {
    expect(sanitizeServerId("GitHub Cloud")).toBe("github_cloud");
    expect(sanitizeServerId("my--server!!v2")).toBe("my_server_v2");
  });

  it("trims separators left at the edges", () => {
    expect(sanitizeServerId(" git hub ")).toBe("git_hub");
    expect(sanitizeServerId("__gh__")).toBe("gh");
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(sanitizeServerId("***")).toBe("");
    expect(sanitizeServerId("")).toBe("");
  });

  it("keeps inner runs of underscores so safe ids stay distinct", () => {
    expect(sanitizeServerId("a__b")).toBe("a__b");
    expect(sanitizeServerId("a__b")).not.toBe(sanitizeServerId("a_b"));
  });

  it("returns an empty string instead of throwing on missing ids", () => {
    expect(sanitizeServerId(undefined)).toBe("");
    expect(sanitizeServerId(null as never)).toBe("");
    expect(sanitizeServerId(42 as never)).toBe("");
  });
});

describe("sanitizeRemoteToolName", () => {
  // Load-bearing for MCP_TOOL_PATTERN: a tool name that still held `__` would
  // be swallowed by the greedy server id, so `parseMcpToolName` must never see
  // one. This test fails the moment the collapse is removed.
  it("collapses double underscores into a single one", () => {
    expect(sanitizeRemoteToolName("a__b")).toBe("a_b");
    expect(sanitizeRemoteToolName("a___b")).toBe("a_b");
    expect(sanitizeRemoteToolName("__a__b__")).toBe("a_b");
    expect(sanitizeRemoteToolName("a__b")).not.toContain("__");
  });

  it("lowercases and replaces unsafe characters", () => {
    expect(sanitizeRemoteToolName("List Issues")).toBe("list_issues");
  });
});

describe("mcpToolName", () => {
  it("builds the mcp__<server>__<tool> name from sanitized parts", () => {
    expect(mcpToolName("github", "list_issues")).toBe("mcp__github__list_issues");
    expect(mcpToolName("GitHub Cloud", "List Issues")).toBe("mcp__github_cloud__list_issues");
  });

  it("does not collapse ids that are already safe", () => {
    expect(mcpToolName("a__b", "x")).not.toBe(mcpToolName("a_b", "x"));
    expect(mcpToolName("a__b", "x")).toBe("mcp__a__b__x");
  });

  it("returns undefined when the server id is empty after sanitizing", () => {
    expect(mcpToolName("", "tool")).toBeUndefined();
    expect(mcpToolName("***", "tool")).toBeUndefined();
  });

  it("returns undefined when the tool name is empty after sanitizing", () => {
    expect(mcpToolName("github", "")).toBeUndefined();
    expect(mcpToolName("github", "!!!")).toBeUndefined();
  });

  it("returns undefined when both parts are empty", () => {
    expect(mcpToolName("", "")).toBeUndefined();
  });

  it("returns undefined instead of throwing on missing parts", () => {
    expect(mcpToolName(undefined, "tool")).toBeUndefined();
    expect(mcpToolName("github", null as never)).toBeUndefined();
  });
});

describe("isMcpToolName", () => {
  it("recognizes MCP tool names", () => {
    expect(isMcpToolName("mcp__github__list_issues")).toBe(true);
    expect(isMcpToolName("mcp__a__b")).toBe(true);
  });

  it("rejects native tool names", () => {
    expect(isMcpToolName("shell")).toBe(false);
    expect(isMcpToolName("use_skill")).toBe(false);
    expect(isMcpToolName("mcp_github")).toBe(false);
    expect(isMcpToolName("mcp____")).toBe(false);
  });
});

describe("parseMcpToolName", () => {
  it("returns the sanitized parts of a generated name", () => {
    const name = mcpToolName("GitHub Cloud", "List Issues");

    expect(parseMcpToolName(name)).toEqual({ serverId: "github_cloud", toolName: "list_issues" });
    expect(parseMcpToolName("mcp__github__list_issues")).toEqual({
      serverId: "github",
      toolName: "list_issues",
    });
  });

  it("returns undefined for names that are not MCP tool names", () => {
    expect(parseMcpToolName("shell")).toBeUndefined();
    expect(parseMcpToolName("mcp__github")).toBeUndefined();
    expect(parseMcpToolName("mcp__GitHub__List Issues")).toBeUndefined();
  });

  it("returns undefined for names with an empty part", () => {
    expect(parseMcpToolName("mcp____tool")).toBeUndefined();
    expect(parseMcpToolName("mcp____")).toBeUndefined();
  });

  // The regex only round-trips because sanitized parts can never contain `__`
  // on the tool side while the server side may. Tabulated so a change to either
  // sanitizer shows up here as a broken pair.
  it("round-trips every generated pair built from sanitized parts", () => {
    const cases: [string, string][] = [
      ["github", "list_issues"],
      ["github", "List__Issues"],
      ["a__b", "x"],
      ["a__b", "x__y"],
      ["a__b__c", "tool__with__runs"],
      ["my__server", "Commit__Changes"],
      ["u_n_d_e_r", "t_n_d_e_r"],
      ["x", "y"],
    ];

    for (const [rawServer, rawTool] of cases) {
      const serverId = sanitizeServerId(rawServer);
      const toolName = sanitizeRemoteToolName(rawTool);
      const composite = mcpToolName(rawServer, rawTool);

      expect(composite).toBe(`mcp__${serverId}__${toolName}`);
      expect(parseMcpToolName(composite!)).toEqual({ serverId, toolName });
    }
  });

  it("recovers a server id that contains double underscores", () => {
    const name = mcpToolName("a__b", "x");

    expect(parseMcpToolName(name!)).toEqual({ serverId: "a__b", toolName: "x" });
  });

  it("round-trips raw ids and tool names through sanitization", () => {
    const cases: [string, string][] = [
      ["github", "list_issues"],
      ["GitHub Cloud", "List Issues"],
      ["a__b", "x__y"],
      ["MY-Server!!", "Weird__Tool Name"],
      ["  spaced  ", "a--b"],
      ["ünïcode", "café"],
    ];

    for (const [serverId, toolName] of cases) {
      const parsed = parseMcpToolName(mcpToolName(serverId, toolName)!);

      expect(parsed).toEqual({
        serverId: sanitizeServerId(serverId),
        toolName: sanitizeRemoteToolName(toolName),
      });
    }
  });
});
