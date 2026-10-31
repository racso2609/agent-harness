import fs from "node:fs";
import path from "node:path";
import { agentsHome, env, harnessHome } from "@/utils/env";
import { DEFAULT_AGENT_ID } from "@/agents/defaults";
import { input, select } from "@/utils/stdin";

interface ProviderConfig {
  url: string;
  apikey: string;
}

interface ShellToolsConfig {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ToolsConfig {
  enabled?: boolean;
  maxIterations?: number;
  approval?: "ask" | "auto" | "deny";
  // Root directory where tools resolve relative paths.
  workspace?: string;
  // Hard cap applied to every tool output before it enters the history.
  maxOutputBytes?: number;
  shell?: ShellToolsConfig;
}

interface AgentsConfig {
  // Directory containing markdown agent definitions.
  dir?: string;
  // Agent used when no explicit one is requested.
  default?: string;
}

interface HarnessConfig {
  model?: string;
  defaultProvider?: string;
  compactThreshold?: number;
  autoCompact?: boolean;
  autoCompactThreshold?: number;

  // Optional provider/model used only to classify prompts, so the cheap
  // classification call never pollutes the main conversation history.
  classificationProvider?: string;
  classificationModel?: string;

  providers: Record<string, ProviderConfig>;
  tools?: ToolsConfig;
  agents?: AgentsConfig;
}

const applyDefaults = (config: HarnessConfig): HarnessConfig => {
  config.compactThreshold ??= 350;
  config.autoCompact ??= true;
  config.autoCompactThreshold ??= 60;
  config.tools ??= {};
  config.tools.enabled ??= true;
  config.tools.maxIterations ??= 8;
  config.tools.approval ??= "auto";
  config.tools.maxOutputBytes ??= 32_768;
  config.tools.shell ??= {};
  config.tools.shell.timeoutMs ??= 30_000;
  config.tools.shell.maxOutputBytes ??= 32_768;
  config.agents ??= {};
  config.agents.dir ??= agentsHome();
  config.agents.default ??= DEFAULT_AGENT_ID;

  return config;
};

const SUPPORTED_PROVIDERS = ["openai"];

const DEFAULT_CONFIG_LOCATION = path.join(
  harnessHome(),
  "config.json",
);

class Config {
  config: HarnessConfig;
  configLocation: string;

  constructor() {
    this.configLocation =
      env.RACSO_HARNESS_CONFIG_LOCATION ?? DEFAULT_CONFIG_LOCATION;
    this.config = applyDefaults(this.readConfig() ?? { providers: {} });
  }

  async startSetup() {
    const provider = await select(
      "Select the provider to configure:",
      SUPPORTED_PROVIDERS,
    );

    let url = (await input(`[${provider}] Base URL: `)).trim();
    if (!url) throw new Error("Base URL is required");
    url = url.replace(/\/+$/, "");

    const apikey = (await input(`[${provider}] API key: `)).trim();
    if (!apikey) throw new Error("API key is required");

    this.config.providers[provider] = { url, apikey };
    this.config.defaultProvider ??= provider;

    const model = (await input("Default model (optional): ")).trim();
    if (model) this.config.model = model;

    this.writeConfig();

    return this.config;
  }

  setupComplete() {
    const provider = this.config.defaultProvider;
    return Boolean(provider && this.config.providers[provider]);
  }

  writeConfig() {
    const dir = path.dirname(this.configLocation);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.configLocation,
      JSON.stringify(this.config, null, 2),
      "utf8",
    );
  }

  readConfig(): HarnessConfig | null {
    try {
      const raw = fs.readFileSync(this.configLocation, "utf8");
      const parsed = JSON.parse(raw) as HarnessConfig;

      parsed.providers ??= {};
      return applyDefaults(parsed);
    } catch {
      return null;
    }
  }
}

export { Config };
export type {
  AgentsConfig,
  HarnessConfig,
  ProviderConfig,
  ShellToolsConfig,
  ToolsConfig,
};
