// 1. usuario ya tiene config?
//   1,1 si => continuar con ciclo basico de session
//   1.2 no => hacer trigger de proceso de configuracion
//  config
//  provider configuration and model

import { Config } from "@/configuration";
import { OpenAiProvider } from "@/providers/openai";
import { Provider } from "@/types/providers";
import { generateSessionId } from "@/utils/session";
import { input, select } from "@/utils/stdin";
// const CLASSIFICATION_PROMPT =
//   'Analiza el prompt del usuario y responde estrictamente en JSON con este formato: {\"is_image_generation\": boolean}."';

const PROVIDER_FACTORIES: Record<
  string,
  (config: { url: string; apikey: string }, model: string) => Provider
> = {
  openai: (config, model) =>
    new OpenAiProvider(config.url, config.apikey, model),
};

interface SessionManager {
  provider?: Provider;
  sessionId: string;
  providerName?: string;
  model?: string;
  // load default config
  initialize: () => Promise<void>;
  changeProvider: (providerName?: string) => Promise<boolean>;
  changeModel: (model?: string) => Promise<boolean>;
  compactSession: () => Promise<boolean>;
  ask(prompt: string): () => ReturnType<Provider["ask"]>;
  // internal
  // la idea es agharrar el propmt pasaarlo por un agent peque;o que no consuma mucho y preguntarle que tipo de accion es textGeneration or imageGeneration para luego enrutarlo a la accion correcta del provider (jev)
  // classifyAction:(prompt)=> Promise<ClassifiedAction>
}

class SessionManagerImpl implements SessionManager {
  id = generateSessionId();
  sessionId = this.id;
  config: Config;
  provider?: Provider;
  providerName?: string;
  model?: string;

  constructor(config = new Config()) {
    this.config = config;
  }

  async initialize() {
    const providerName = this.config.config.defaultProvider;
    if (!providerName) throw new Error("No default provider configured");

    const providerConfig = this.config.config.providers[providerName];
    if (!providerConfig) throw new Error(`Missing config for ${providerName}`);

    const model = this.config.config.model;
    if (!model) throw new Error("No default model configured");

    this.provider = this.createProvider(providerName, providerConfig, model);
    await this.provider.initialize();

    this.providerName = providerName;
    this.model = this.provider.getModel();
  }

  async changeProvider(providerName?: string) {
    if (!this.provider) throw new Error("Session not initialized");

    const name =
      providerName ??
      (await select(
        "Select the provider:",
        Object.keys(this.config.config.providers),
      ));

    const providerConfig = this.config.config.providers[name];
    if (!providerConfig) return false;

    const model = this.model ?? this.config.config.model;
    if (!model) return false;

    const provider = this.createProvider(name, providerConfig, model);
    await provider.initialize();

    if (!provider.setModel(model)) return false;

    this.provider = provider;
    this.providerName = name;
    this.model = provider.getModel();

    return true;
  }

  async changeModel(model?: string) {
    if (!this.provider) throw new Error("Session not initialized");

    const name =
      model ??
      (await select(
        "Select the model:",
        this.provider.listModels?.().map((m) => m.id) ?? [],
      ));

    if (!this.provider.setModel(name)) return false;

    this.model = this.provider.getModel();
    this.config.config.model = this.model;
    this.config.writeConfig();

    return true;
  }

  async compactSession() {
    if (!this.provider) throw new Error("Session not initialized");
    this.provider.compact(this.config.config.compactThreshold);
    return true;
  }

  async ask(prompt: string) {
    if (!this.provider) throw new Error("Session not initialized");
    return this.provider.ask(prompt);
  }

  protected createProvider(
    name: string,
    config: { url: string; apikey: string },
    model: string,
  ) {
    const factory = PROVIDER_FACTORIES[name];
    if (!factory) throw new Error(`Unsupported provider: ${name}`);
    return factory(config, model);
  }
}

export { SessionManagerImpl as SessionManager };
export type { SessionManager as SessionManagerContract };
