import { Config } from "@/configuration";
import { OpenAiProvider } from "@/providers/openai";
import { Provider } from "@/types/providers";
import { generateSessionId } from "@/utils/session";
import { logger } from "@/utils/logger";
import { select } from "@/utils/stdin";
import { ClassifiedAction, classifyAction } from "./classifyAction";
import { SessionRecord, SessionStore } from "./SessionStore";

// Options accepted by initialize/load to resume an existing session.
export interface SessionOptions {
  // Id of a previously persisted session to resume.
  sessionId?: string;
  // Store used for persistence; defaults to a new SessionStore.
  store?: SessionStore;
}

// Registry mapping a provider name (as used in the config) to a factory
// that builds the concrete Provider implementation for that backend.
const PROVIDER_FACTORIES: Record<
  string,
  (config: { url: string; apikey: string }, model: string) => Provider
> = {
  openai: (config, model) =>
    new OpenAiProvider(config.url, config.apikey, model),
};

// Public contract of the session manager.
// Concrete implementation is SessionManagerImpl below.
interface SessionManager {
  provider?: Provider;
  sessionId: string;
  providerName?: string;
  model?: string;
  // load default config
  // Boots the session using the default provider/model stored in config.
  initialize: (options?: SessionOptions) => Promise<void>;
  // Restores a previously persisted session by id. Returns false if missing.
  load: (sessionId: string) => Promise<boolean>;
  // Persists the current session state to the store.
  save: () => void;
  // Swaps the active provider. Prompts interactively when name is omitted.
  changeProvider: (providerName?: string) => Promise<boolean>;
  // Swaps the model of the active provider. Prompts when model is omitted.
  changeModel: (model?: string) => Promise<boolean>;
  // TODO: placeholder for history compaction.
  compactSession: () => Promise<boolean>;
  // Routes the prompt to text or image generation based on classification.
  ask: (prompt: string) => ReturnType<Provider["ask"]>;
  // internal
  // la idea es agharrar el propmt pasaarlo por un agent peque;o que no consuma mucho y preguntarle que tipo de accion es textGeneration or imageGeneration para luego enrutarlo a la accion correcta del provider (jev)
  classifyAction: (prompt: string) => Promise<ClassifiedAction>;
}

class SessionManagerImpl implements SessionManager {
  // Unique identifier for this session.
  id: string = generateSessionId();
  sessionId: string = this.id;
  // Configuration source (providers + default model).
  config: Config;
  // Active provider instance, undefined until initialize() succeeds.
  provider?: Provider;
  // Secondary provider used only to classify prompts. Kept isolated so its
  // classification traffic never pollutes the main conversation history.
  classifierProvider?: Provider;
  // Name of the active provider as keyed in the config.
  providerName?: string;
  // Active model id.
  model?: string;
  // Persistence layer for this session.
  store: SessionStore;
  // Creation timestamp, preserved when resuming an existing session.
  createdAt: string;

  constructor(config = new Config(), store = new SessionStore()) {
    this.config = config;
    this.store = store;
    this.createdAt = new Date().toISOString();
  }

  // Initializes the session from the persisted config:
  // creates the provider, loads its model list and applies the default model.
  // When options.sessionId is given, the stored session is resumed instead.
  async initialize(options: SessionOptions = {}) {
    if (options.store) this.store = options.store;

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

    await this.initializeClassifier();

    const resumed = options.sessionId && (await this.load(options.sessionId));

    if (!resumed) this.save();
  }

  // Restores a persisted session into this instance: rebuilds the provider,
  // applies the stored model and replays the conversation history.
  async load(sessionId: string) {
    const record = this.store.load(sessionId);
    if (!record) return false;

    const providerConfig = this.config.config.providers[record.provider];
    if (!providerConfig) return false;

    const provider = this.createProvider(
      record.provider,
      providerConfig,
      record.model,
    );
    await provider.initialize();
    if (!provider.setModel(record.model)) return false;

    provider.history = record.history ?? [];

    this.id = record.id;
    this.sessionId = record.id;
    this.createdAt = record.createdAt;
    this.provider = provider;
    this.providerName = record.provider;
    this.model = provider.getModel();

    await this.initializeClassifier();

    return true;
  }

  // Serializes the current state into the store, refreshing updatedAt.
  save() {
    if (!this.provider || !this.providerName || !this.model) return;

    const record: SessionRecord = {
      id: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      provider: this.providerName,
      model: this.model,
      history: this.provider.history,
    };

    this.store.save(record);
  }

  // Replaces the active provider, keeping the current model when possible.
  // Returns false when the target provider or model is unavailable.
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

    await this.initializeClassifier();

    this.save();
    return true;
  }

  // Changes the model of the active provider and persists it to the config.
  // Returns false when the model is not offered by the provider.
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

    this.save();
    return true;
  }

  // Compacts the provider history using the configured threshold.
  async compactSession() {
    if (!this.provider) throw new Error("Session not initialized");
    this.provider.compact(this.config.config.compactThreshold);
    this.save();
    return true;
  }

  // Classifies the prompt and dispatches it to text or image generation.
  async ask(prompt: string) {
    if (!this.provider) throw new Error("Session not initialized");

    const action = await this.classifyAction(prompt);

    const response =
      action === "imageGeneration"
        ? await this.provider.generateImage(prompt)
        : await this.provider.ask(prompt);

    this.save();
    return response;
  }

  // Determines whether the prompt is a text or image generation request.
  // Uses the isolated classifier provider when available so the extra call
  // never lands in the main conversation history.
  async classifyAction(prompt: string) {
    if (!this.provider) throw new Error("Session not initialized");
    return classifyAction(prompt, this.classifierProvider ?? this.provider);
  }

  // Builds the secondary provider used only for prompt classification.
  // Falls back to the main provider when no dedicated one is configured.
  protected async initializeClassifier() {
    const name =
      this.config.config.classificationProvider ?? this.providerName;
    const model =
      this.config.config.classificationModel ?? this.config.config.model;

    if (!name || !model) {
      this.classifierProvider = undefined;
      return;
    }

    const providerConfig = this.config.config.providers[name];
    if (!providerConfig) {
      this.classifierProvider = undefined;
      return;
    }

    try {
      const provider = this.createProvider(name, providerConfig, model);
      await provider.initialize();

      if (!provider.setModel(model)) {
        this.classifierProvider = undefined;
        return;
      }

      this.classifierProvider = provider;
    } catch (err) {
      logger.warn({ err }, "classifier provider init failed, using fallback");
      this.classifierProvider = undefined;
    }
  }

  // Resolves the factory for the given provider name and instantiates it.
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
