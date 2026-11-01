import fs from "node:fs";
import path from "node:path";
import { agentsHome, env, harnessHome } from "@/utils/env";
import { DEFAULT_AGENT_ID } from "@/agents/defaults";

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
  // Extra glob-ish paths (workspace-relative) that writeFile must refuse.
  writeDeny?: string[];
  // Reinterpret tool calls emitted as plain text markup (DeepSeek-style).
  normalizeTextToolCalls?: boolean;
  shell?: ShellToolsConfig;
}

interface AgentsConfig {
  // Directory containing markdown agent definitions.
  dir?: string;
  // Agent used when no explicit one is requested.
  default?: string;
}

interface SessionsConfig {
  // Master switch for spawning background child agents.
  spawnEnabled?: boolean;
  // Cap on concurrent child sessions a parent may run.
  maxChildren?: number;
  // Wall-clock budget for a child turn before it is abandoned.
  childTimeoutMs?: number;
  // Cap on the child result injected back into the parent history.
  childResultMaxChars?: number;
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
  sessions?: SessionsConfig;
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
  config.tools.normalizeTextToolCalls ??= true;
  config.tools.shell ??= {};
  config.tools.shell.timeoutMs ??= 30_000;
  config.tools.shell.maxOutputBytes ??= 32_768;
  config.agents ??= {};
  config.agents.dir ??= agentsHome();
  config.agents.default ??= DEFAULT_AGENT_ID;
  config.sessions ??= {};
  config.sessions.spawnEnabled ??= true;
  config.sessions.maxChildren ??= 4;
  config.sessions.childTimeoutMs ??= 300_000;
  config.sessions.childResultMaxChars ??= 2000;

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

  // True when the config cannot boot a session yet.
  needsSetup() {
    return !this.validateConfig().ok;
  }

  // Checks that a default provider is configured and usable.
  validateConfig() {
    const errors: string[] = [];
    const provider = this.config.defaultProvider;

    if (!provider) {
      errors.push("No default provider configured");
    } else {
      const providerConfig = this.config.providers[provider];
      if (!providerConfig) {
        errors.push(`Missing config for provider: ${provider}`);
      } else {
        if (!providerConfig.url?.trim()) {
          errors.push(`Provider ${provider} is missing a base URL`);
        }
        if (!providerConfig.apikey?.trim()) {
          errors.push(`Provider ${provider} is missing an API key`);
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // Stores a provider definition without prompting. Used by the CLI setup flow.
  configureProvider(
    name: string,
    provider: ProviderConfig,
    options: { makeDefault?: boolean; model?: string } = {},
  ) {
    this.config.providers[name] = {
      url: provider.url.replace(/\/+$/, ""),
      apikey: provider.apikey,
    };

    if (options.makeDefault || !this.config.defaultProvider) {
      this.config.defaultProvider = name;
    }
    if (options.model) this.config.model = options.model;
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

export { Config, SUPPORTED_PROVIDERS };
export type {
  AgentsConfig,
  HarnessConfig,
  ProviderConfig,
  SessionsConfig,
  ShellToolsConfig,
  ToolsConfig,
};
