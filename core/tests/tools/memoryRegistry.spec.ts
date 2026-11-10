import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import { createToolRegistry } from "../../src/tools";
import type { RememberInput, RememberResult, ToolContext } from "../../src/tools/Tool";

// A Config stand-in: createToolRegistry only reads `.config`.
const makeConfig = (memory: Record<string, unknown> = {}) =>
  ({ config: { providers: {}, tools: {}, memory } }) as unknown as Config;

const makeCtx = (
rememberMemory?: (input: RememberInput) => Promise<RememberResult>,
): ToolContext => ({
cwd: process.cwd(),
sessionId: "session",
approve: async () => "allow",
...(rememberMemory ? { rememberMemory } : {}),
});

// A fact with no topicKey: its acceptance depends only on the backend.
const factWithoutKey = {
kind: "fact",
scope: "project",
title: "Deploy pipeline",
content: "CI runs the deploy through GitHub Actions.",
};

const names = (config: Config, allowedTools?: string[]) =>
  createToolRegistry(config, allowedTools)
    .list()
    .map((tool) => tool.name);

describe("createToolRegistry and the memory write tools", () => {
  it("offers remember and forget when memory is on and there is no allowlist", () => {
    const offered = names(makeConfig({ enabled: true }));

    expect(offered).toContain("remember");
    expect(offered).toContain("forget");
  });

  it("hides both when memory is off", () => {
    const offered = names(makeConfig({ enabled: false }));

    expect(offered).not.toContain("remember");
    expect(offered).not.toContain("forget");
  });

  it("hides both when memory is not configured at all", () => {
    const offered = names(makeConfig());

    expect(offered).not.toContain("remember");
    expect(offered).not.toContain("forget");
  });

  it("honours the rememberTool knob on its own", () => {
    const offered = names(makeConfig({ enabled: true, rememberTool: false }));

    expect(offered).not.toContain("remember");
    expect(offered).toContain("forget");
  });

  it("honours the forgetTool knob on its own", () => {
    const offered = names(makeConfig({ enabled: true, forgetTool: false }));

    expect(offered).toContain("remember");
    expect(offered).not.toContain("forget");
  });

  it("passes maxCaptureChars to the remember tool", () => {
    const registry = createToolRegistry(makeConfig({ enabled: true, maxCaptureChars: 12 }));
    const remember = registry.get("remember");
    const content = (remember?.parameters as { properties: { content: { description: string } } })
      .properties.content.description;

    expect(content).toContain("12 characters");
  });

  it("offers neither when the agent declares an allowlist that does not name them", () => {
    const offered = names(makeConfig({ enabled: true }), ["readFile"]);

    expect(offered).not.toContain("remember");
    expect(offered).not.toContain("forget");
  });

  it("does not offer them to an agent that names them either", () => {
    // Same gate as recall: the allowlist is all-or-nothing for the memory
    // tools, so naming one is not a way to get it.
    expect(names(makeConfig({ enabled: true }), ["remember"])).toEqual([]);
    expect(names(makeConfig({ enabled: true }), ["forget"])).toEqual([]);
  });
it("does not require a topicKey for a fact when the backend is http", async () => {
// The http provider (Engram) drops topicKey, so demanding one would only make
// the model invent it. The tool must get all the way to the write.
const registry = createToolRegistry(makeConfig({ enabled: true, provider: "http" }));
const rememberMemory = vi.fn(async () => ({ id: "1" }));

const result = await registry.get("remember")?.execute(makeCtx(rememberMemory), factWithoutKey);

expect(rememberMemory).toHaveBeenCalledWith(expect.objectContaining({ kind: "fact" }));
expect(rememberMemory.mock.calls[0]?.[0]).not.toHaveProperty("topicKey");
expect(result).toEqual({ output: "Remembered as id 1 (fact, scope project)." });
});

it("requires a topicKey for a fact when the backend is local", async () => {
const registry = createToolRegistry(makeConfig({ enabled: true, provider: "local" }));
const rememberMemory = vi.fn(async () => ({ id: "1" }));

const result = await registry.get("remember")?.execute(makeCtx(rememberMemory), factWithoutKey);

expect(result).toEqual({
output:
"remember requires 'topicKey' for kind 'fact': it is what makes a later memory replace this one instead of duplicating it. Only 'episode' may omit it.",
isError: true,
});
expect(rememberMemory).not.toHaveBeenCalled();
});

it("keeps the topicKey requirement for a backend other than http", async () => {
// The exemption is http-specific, not "anything that is not local": a mutant
// that flipped the test to provider === "local" would let this one through.
const registry = createToolRegistry(makeConfig({ enabled: true, provider: "engram" }));
const rememberMemory = vi.fn(async () => ({ id: "1" }));

const result = await registry.get("remember")?.execute(makeCtx(rememberMemory), factWithoutKey);

expect(result).toEqual({
output:
"remember requires 'topicKey' for kind 'fact': it is what makes a later memory replace this one instead of duplicating it. Only 'episode' may omit it.",
isError: true,
});
expect(rememberMemory).not.toHaveBeenCalled();
});

it("treats a memory config with no provider as the local one", async () => {
// Unknown is assumed to upsert, but the default backend is local: no provider
// must behave like local and keep the topicKey requirement.
const registry = createToolRegistry(makeConfig({ enabled: true }));
const rememberMemory = vi.fn(async () => ({ id: "1" }));

const result = await registry.get("remember")?.execute(makeCtx(rememberMemory), factWithoutKey);

expect(result).toEqual({
output:
"remember requires 'topicKey' for kind 'fact': it is what makes a later memory replace this one instead of duplicating it. Only 'episode' may omit it.",
isError: true,
});
expect(rememberMemory).not.toHaveBeenCalled();
});
});
