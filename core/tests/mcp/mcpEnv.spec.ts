import { afterEach, describe, expect, it, vi } from "vitest";

const setEnv = (value: string | undefined) => {
  vi.stubEnv("RACSO_HARNESS_MCP_DISABLED", value as string);
  // env.ts reads process.env once at import time, so re-import it per case.
  vi.resetModules();
};

const load = async (): Promise<boolean> => {
  const module = await import("../../src/mcp/mcpEnv");
  return module.mcpDisabledByEnv();
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("mcpDisabledByEnv", () => {
  it.each(["1", "true", "TRUE", "yes", " 1 "])("treats %j as disabled", async (value) => {
    setEnv(value);
    expect(await load()).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "maybe"])("treats %j as enabled", async (value) => {
    setEnv(value);
    expect(await load()).toBe(false);
  });
});
