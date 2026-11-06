import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessHome } from "../../src/utils/env";

let dir: string;

const configPath = () => path.join(dir, "config.json");

const loadConfig = async () => {
  vi.resetModules();
  const { Config } = await import("../../src/configuration");
  return new Config();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-config-"));
  vi.stubEnv("RACSO_HARNESS_CONFIG_LOCATION", configPath());
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Config memory", () => {
  it("is off by default", async () => {
    const config = await loadConfig();

    expect(config.config.memory?.enabled).toBe(false);
  });

  it("defaults every knob without memory configured", async () => {
    const config = await loadConfig();

    expect(config.config.memory).toMatchObject({
      enabled: false,
      provider: "local",
      maxContextChars: 2000,
      maxHitChars: 1200,
      timeoutMs: 5000,
      injectOnStart: true,
      captureOnCompact: true,
      recallTool: true,
    });
  });

  it("points the local store at memory.db under the harness home", async () => {
    const config = await loadConfig();
    const memoryPath = config.config.memory?.path ?? "";

    expect(path.isAbsolute(memoryPath)).toBe(true);
    expect(path.basename(memoryPath)).toBe("memory.db");
    expect(path.dirname(memoryPath)).toBe(harnessHome());
  });

  it("respects an explicit memory block and keeps the other defaults", async () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        providers: {},
        memory: {
          enabled: true,
          provider: "http",
          url: "http://127.0.0.1:7437",
          maxContextChars: 500,
        },
      }),
    );

    const config = await loadConfig();

    expect(config.config.memory?.enabled).toBe(true);
    expect(config.config.memory?.provider).toBe("http");
    expect(config.config.memory?.url).toBe("http://127.0.0.1:7437");
    expect(config.config.memory?.maxContextChars).toBe(500);
    expect(config.config.memory?.timeoutMs).toBe(5000);
  });
});
