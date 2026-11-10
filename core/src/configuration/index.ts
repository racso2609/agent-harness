import fs from "node:fs";
import path from "node:path";
import { agentsHome, env, harnessHome, skillsHome } from "@/utils/env";
import { DEFAULT_AGENT_ID } from "@/agents/defaults";
import type { McpConfig } from "@/mcp/McpConfig";

interface ProviderConfig {
  // Backend that interprets url/apikey. Defaults to "openai" so configs
  // written before instance ids existed keep working unchanged.
  type?: string;
  url: string;
  apikey: string;
  // Preferred model for this instance; used as the fallback when the active
  // model does not exist on the target instance.
  model?: string;
}

// Provider entry as listed by Config, with its instance id resolved.
interface ProviderDetail extends ProviderConfig {
  id: string;
  isDefault: boolean;
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

interface SkillsConfig {
  // Master switch for the lazy skill registry and the use_skill tool.
  enabled?: boolean;
  // Directories scanned for SKILL.md or <id>.md. Earlier dirs win on clashes.
  dirs?: string[];
  // Cap applied to each description in the system prompt index.
  maxIndexChars?: number;
  // Cap applied to a skill body returned by use_skill.
  maxBodyChars?: number;
  // Skill ids loaded eagerly (reserved; unused by the MVP).
  preload?: string[];
}

interface MemoryConfig {
  // Master switch. Off by default: with false the prompt and the history are
  // byte-identical to a build without memory.
  enabled?: boolean;
  // "none" | "local" | "http" | "mcp". Selects the implementation.
  provider?: string;
  // Default scope for what is written and searched.
  project?: string;
  // --- http ---
  url?: string;
  apikey?: string;
  // --- mcp ---
  command?: string;
  args?: string[];
  // --- local ---
  path?: string;
  // --- injection ---
  injectOnStart?: boolean;
  maxContextChars?: number;
  maxHitChars?: number;
  // --- capture ---
  captureOnCompact?: boolean;
  // --- tool ---
  recallTool?: boolean;
  // Same off-switch as recallTool, one per write path: each tool is only
  // offered when memory is enabled and its knob is not false.
  rememberTool?: boolean;
  forgetTool?: boolean;
  // Cap on the content the remember tool accepts, from memory.maxCaptureChars.
  maxCaptureChars?: number;
  // --- network ---
  timeoutMs?: number;
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
  // Turns a parent may start on its own after a child leaves work behind.
  // `0` and `false` mean disabled: no automatic continuation ever starts.
  maxAutoContinuations?: number | false;
}

// One visual role. `color` is a colour name understood by the CLI; `dim`
// lowers opacity.
interface UiRoleStyle {
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

// Per-role styling for the terminal UI. Roles left out keep the defaults.
interface UiTheme {
  // The user's own message.
  user?: UiRoleStyle;
  // Model reasoning streamed before the answer.
  reasoning?: UiRoleStyle;
  // Tool name, arguments and live output.
  tool?: UiRoleStyle;
  // Final assistant answer.
  answer?: UiRoleStyle;
  // Notices, pending work and harness errors.
  notice?: UiRoleStyle;
}

interface UiConfig {
  theme?: UiTheme;
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

  // Provider instances keyed by a free-form id (cheap, openrouter, work...).
  providers: Record<string, ProviderConfig>;
  tools?: ToolsConfig;
  agents?: AgentsConfig;
  sessions?: SessionsConfig;
  skills?: SkillsConfig;
  // Remote MCP servers exposed as extra tools. Off unless enabled.
  mcp?: McpConfig;
  memory?: MemoryConfig;
  ui?: UiConfig;
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
  config.sessions.maxAutoContinuations ??= 5;
  config.skills ??= {};
  config.skills.enabled ??= true;
  config.skills.dirs ??= [skillsHome()];
  config.skills.maxIndexChars ??= 160;
  config.skills.maxBodyChars ??= 16_000;
  config.skills.preload ??= [];
  // Like tools, sessions and skills, writeConfig persists these defaults into
  // the user's config.json, so changing a number here will not reach existing users.
  config.mcp ??= {};
  config.mcp.enabled ??= false;
  config.mcp.servers ??= {};
  config.mcp.maxDescriptionChars ??= 300;
  config.mcp.maxToolsIndexChars ??= 2000;
  config.mcp.startupTimeoutMs ??= 10_000;
  config.mcp.callTimeoutMs ??= 60_000;
  config.mcp.maxConcurrentCalls ??= 4;
  config.memory ??= {};
  config.memory.enabled ??= false;
  config.memory.provider ??= "local";
  config.memory.injectOnStart ??= true;
  config.memory.maxContextChars ??= 2000;
  config.memory.maxHitChars ??= 1200;
  config.memory.captureOnCompact ??= true;
  config.memory.recallTool ??= true;
  config.memory.rememberTool ??= true;
  config.memory.forgetTool ??= true;
  config.memory.maxCaptureChars ??= 4000;
  config.memory.timeoutMs ??= 5000;
  config.memory.path ??= path.join(harnessHome(), "memory.db");
  config.ui ??= {};
  config.ui.theme ??= {};
  config.ui.theme.user ??= { color: "cyan" };
  config.ui.theme.reasoning ??= { color: "gray", dim: true };
  config.ui.theme.tool ??= { color: "yellow" };
  config.ui.theme.answer ??= { bold: true };
  config.ui.theme.notice ??= { color: "gray", dim: true };

  return config;
};

const SUPPORTED_PROVIDERS = ["openai"];

const DEFAULT_PROVIDER_TYPE = "openai";

const DEFAULT_CONFIG_LOCATION = path.join(harnessHome(), "config.json");

class Config {
  config: HarnessConfig;
  configLocation: string;

  constructor() {
    this.configLocation = env.RACSO_HARNESS_CONFIG_LOCATION ?? DEFAULT_CONFIG_LOCATION;
    this.config = applyDefaults(this.readConfig() ?? { providers: {} });
  }

  // True when the config cannot boot a session yet.
  needsSetup() {
    return !this.validateConfig().ok;
  }

  // Checks that every provider entry is usable and that the default one exists.
  validateConfig() {
    const errors: string[] = [];
    const provider = this.config.defaultProvider;

    if (!provider) {
      errors.push("No default provider configured");
    } else if (!this.config.providers[provider]) {
      errors.push(`Missing config for provider: ${provider}`);
    }

    for (const [id, providerConfig] of Object.entries(this.config.providers)) {
      errors.push(...this.validateProvider(id, providerConfig));
    }

    return { ok: errors.length === 0, errors };
  }

  // Validates one provider entry: backend type, base URL and API key.
  validateProvider(id: string, providerConfig: ProviderConfig) {
    const errors: string[] = [];
    const type = providerConfig.type ?? DEFAULT_PROVIDER_TYPE;

    if (!SUPPORTED_PROVIDERS.includes(type)) {
      errors.push(
        `Provider ${id} uses an unsupported type: ${type} (supported: ${SUPPORTED_PROVIDERS.join(", ")})`,
      );
    }
    if (!providerConfig.url?.trim()) {
      errors.push(`Provider ${id} is missing a base URL`);
    }
    if (!providerConfig.apikey?.trim()) {
      errors.push(`Provider ${id} is missing an API key`);
    }

    return errors;
  }

  // Stores a provider instance without prompting. `id` is a free-form name
  // chosen by the user and `provider.type` selects the backend implementation.
  // Used by the CLI setup and add-provider flows.
  configureProvider(
    id: string,
    provider: ProviderConfig,
    options: { makeDefault?: boolean; model?: string } = {},
  ) {
    this.config.providers[id] = {
      type: provider.type ?? DEFAULT_PROVIDER_TYPE,
      url: provider.url.replace(/\/+$/, ""),
      apikey: provider.apikey,
      ...(provider.model ? { model: provider.model } : {}),
    };

    if (options.makeDefault || !this.config.defaultProvider) {
      this.config.defaultProvider = id;
    }
    if (options.model) this.config.model = options.model;
  }

  // Removes a provider instance. Returns false when it does not exist.
  // Sessions persisted with that id stay on disk untouched.
  removeProvider(id: string) {
    if (!this.config.providers[id]) return false;

    delete this.config.providers[id];

    if (this.config.defaultProvider === id) {
      const [next] = this.listProviders();
      this.config.defaultProvider = next;
    }

    return true;
  }

  // Lists the provider instances with their id and default flag.
  listProviderDetails(): ProviderDetail[] {
    return this.listProviders().map((id) => {
      const provider = this.config.providers[id];

      return {
        id,
        type: provider.type ?? DEFAULT_PROVIDER_TYPE,
        url: provider.url,
        apikey: provider.apikey,
        ...(provider.model ? { model: provider.model } : {}),
        isDefault: this.config.defaultProvider === id,
      };
    });
  }

  // Lists the provider instance ids currently configured.
  listProviders() {
    return Object.keys(this.config.providers);
  }

  writeConfig() {
    const dir = path.dirname(this.configLocation);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configLocation, JSON.stringify(this.config, null, 2), "utf8");
  }

  readConfig(): HarnessConfig | null {
    try {
      const raw = fs.readFileSync(this.configLocation, "utf8");
      const parsed = JSON.parse(raw) as HarnessConfig;

      parsed.providers ??= {};
      for (const entry of Object.values(parsed.providers)) {
        entry.type ??= DEFAULT_PROVIDER_TYPE;
      }
      return applyDefaults(parsed);
    } catch {
      return null;
    }
  }
}

export { Config, DEFAULT_PROVIDER_TYPE, SUPPORTED_PROVIDERS };
export type {
  AgentsConfig,
  HarnessConfig,
  McpConfig,
  MemoryConfig,
  UiConfig,
  UiRoleStyle,
  UiTheme,
  ProviderConfig,
  ProviderDetail,
  SessionsConfig,
  ShellToolsConfig,
  SkillsConfig,
  ToolsConfig,
};
