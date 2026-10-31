import fs from "node:fs";
import path from "node:path";
import { env, harnessHome } from "@/utils/env";
import { input, select } from "@/utils/stdin";

interface ProviderConfig {
  url: string;
  apikey: string;
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
}

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
    this.config = this.readConfig() ?? { providers: {} };
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

      // 10mensajes el max history message antes de compactar
      if (!parsed.compactThreshold) parsed.compactThreshold = 100;
      if (parsed.autoCompact === undefined) parsed.autoCompact = true;
      if (!parsed.autoCompactThreshold) parsed.autoCompactThreshold = 80;
      parsed.providers ??= {};
      return parsed;
    } catch {
      return null;
    }
  }
}

export { Config };
export type { HarnessConfig, ProviderConfig };
