import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

const configPath = () => path.join(dir, "config.json");

const loadConfig = async () => {
  vi.resetModules();
  const { Config } = await import("../../src/configuration");
  return new Config();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-config-"));
  vi.stubEnv("RACSO_HARNESS_CONFIG_LOCATION", configPath());
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Config providers", () => {
  it("defaults legacy entries without type to openai", async () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        defaultProvider: "openai",
        providers: {
          openai: { url: "https://api.example.com", apikey: "key" },
        },
      }),
    );

    const config = await loadConfig();

    expect(config.listProviderDetails()).toEqual([
      {
        id: "openai",
        type: "openai",
        url: "https://api.example.com",
        apikey: "key",
        isDefault: true,
      },
    ]);
    expect(config.validateConfig()).toEqual({ ok: true, errors: [] });
  });

  it("supports several instances sharing the same backend type", async () => {
    const config = await loadConfig();

    config.configureProvider(
      "cheap",
      {
        type: "openai",
        url: "https://cheap.example.com/v1/",
        apikey: "cheap-key",
        model: "cheap-model",
      },
      { makeDefault: true },
    );
    config.configureProvider("openrouter", {
      type: "openai",
      url: "https://openrouter.ai/api/v1",
      apikey: "or-key",
    });
    config.writeConfig();

    const reloaded = await loadConfig();

    expect(reloaded.listProviders()).toEqual(["cheap", "openrouter"]);
    expect(reloaded.listProviderDetails()).toEqual([
      {
        id: "cheap",
        type: "openai",
        url: "https://cheap.example.com/v1",
        apikey: "cheap-key",
        model: "cheap-model",
        isDefault: true,
      },
      {
        id: "openrouter",
        type: "openai",
        url: "https://openrouter.ai/api/v1",
        apikey: "or-key",
        isDefault: false,
      },
    ]);
    expect(reloaded.validateConfig()).toEqual({ ok: true, errors: [] });
  });

  it("reassigns the default when the default instance is removed", async () => {
    const config = await loadConfig();
    config.configureProvider("one", {
      url: "https://one.example.com",
      apikey: "k1",
    });
    config.configureProvider("two", {
      url: "https://two.example.com",
      apikey: "k2",
    });

    expect(config.removeProvider("one")).toBe(true);
    expect(config.removeProvider("missing")).toBe(false);

    expect(config.listProviders()).toEqual(["two"]);
    expect(config.listProviderDetails()[0].isDefault).toBe(true);
  });

  it("reports unsupported types and missing credentials", async () => {
    const config = await loadConfig();
    config.configureProvider("bad", {
      type: "anthropic",
      url: "",
      apikey: "",
    });

    const { ok, errors } = config.validateConfig();

    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining([
        "Provider bad uses an unsupported type: anthropic (supported: openai)",
        "Provider bad is missing a base URL",
        "Provider bad is missing an API key",
      ]),
    );
  });
});
