import {
  AgentDefinition,
  AgentLoader,
  AgentRegistry,
  AgentSummary,
  builtInDefaultAgent,
  composeSystemPrompt,
  DEFAULT_AGENT_ID,
  strictestApproval,
} from "@/agents";
import { Config } from "@/configuration";
import { OpenAiProvider } from "@/providers/openai";
import { createToolRegistry, ToolContext, ToolRegistry } from "@/tools";
import {
  AgentResponse,
  History,
  Provider,
  TokenUsage,
  ToolCall,
  ToolResult,
} from "@/types/providers";
import { SessionStatus, SessionUsage } from "@/types/session";
import { generateSessionId } from "@/utils/session";
import { logger } from "@/utils/logger";
import { input, select } from "@/utils/stdin";
import { ClassifiedAction, classifyAction } from "./classifyAction";
import {
  compactHistory,
  DEFAULT_COMPACT_THRESHOLD,
  estimateHistoryTokens,
} from "./history";
import { SessionRecord, SessionStore } from "./SessionStore";

// Options accepted by initialize/load to resume an existing session.
export interface SessionOptions {
  // Id of a previously persisted session to resume.
  sessionId?: string;
  // Agent to use when starting a new session.
  agent?: string;
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
  agentId: string;
  agent?: AgentDefinition;
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
  // Lists the agents available from the agents directory.
  listAgents: () => AgentSummary[];
  // Swaps the active agent, its tools and its persona.
  changeAgent: (agentId?: string) => Promise<boolean>;
  // TODO: placeholder for history compaction.
  compactSession: () => Promise<boolean>;
  // Returns the current session usage, cost and context status.
  status: () => SessionStatus;
  // Routes the prompt to text or image generation based on classification.
  ask: (prompt: string) => Promise<AgentResponse>;
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
  // Active agent id and definition.
  agentId: string = DEFAULT_AGENT_ID;
  agent?: AgentDefinition;
  // Available agent definitions; starts with only the embedded default.
  agentRegistry = new AgentRegistry([builtInDefaultAgent()]);
  protected agentsLoaded = false;
  // Active provider instance, undefined until initialize() succeeds.
  provider?: Provider;
  // Conversation history owned by the session, replayed into the provider.
  history: History[] = [];
  // Secondary provider used only to classify prompts. Kept isolated so its
  // classification traffic never pollutes the main conversation history.
  classifierProvider?: Provider;
  // Name of the active provider as keyed in the config.
  providerName?: string;
  // Active model id.
  model?: string;
  // Persistence layer for this session.
  store: SessionStore;
  // Tools available to the ReAct loop.
  tools: ToolRegistry;
  // Creation timestamp, preserved when resuming an existing session.
  createdAt: string;
  // Accumulated token usage for this session.
  usage: SessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  // Accumulated cost in USD for this session.
  costUsd = 0;

  constructor(config = new Config(), store = new SessionStore()) {
    this.config = config;
    this.store = store;
    this.tools = createToolRegistry(this.config);
    this.createdAt = new Date().toISOString();
  }

  // Initializes the session from the persisted config:
  // creates the provider, loads its model list and applies the default model.
  // When options.sessionId is given, the stored session is resumed instead.
  async initialize(options: SessionOptions = {}) {
    if (options.store) this.store = options.store;

    this.loadAgentRegistry();
    const agent = this.resolveAgent(
      options.agent ?? this.config.config.agents?.default,
    );
    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools);

    const providerName =
      agent.provider ?? this.config.config.defaultProvider;
    if (!providerName) throw new Error("No default provider configured");

    const providerConfig = this.config.config.providers[providerName];
    if (!providerConfig) throw new Error(`Missing config for ${providerName}`);

    const model = agent.model ?? this.config.config.model;
    if (!model) throw new Error("No default model configured");

    this.provider = this.createProvider(providerName, providerConfig, model);
    await this.provider.initialize();

    this.providerName = providerName;
    this.model = this.provider.getModel();

    await this.initializeClassifier();

    const resumed = options.sessionId && (await this.load(options.sessionId));

    if (!resumed) {
      this.applySystemPrompt();
      this.save();
    }
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

    const agent = this.resolveAgent(
      record.agentId ?? this.config.config.agents?.default,
    );
    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools);

    this.history = record.history ?? [];
    // Sessions persisted with an agent already start with its persona. Older
    // sessions keep their system messages (e.g. compacted memory) untouched.
    this.applySystemPrompt(Boolean(record.agentId));

    this.id = record.id;
    this.sessionId = record.id;
    this.createdAt = record.createdAt;
    this.provider = provider;
    this.providerName = record.provider;
    this.model = provider.getModel();
    this.usage = record.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.costUsd = record.costUsd ?? 0;

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
      agentId: this.agentId,
      history: this.history,
      usage: this.usage,
      costUsd: this.costUsd,
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

  // Lists the agents discovered in the agents directory.
  listAgents() {
    this.ensureAgentRegistry();
    return this.agentRegistry.summaries();
  }

  // Swaps the active agent and applies its provider, model, tools and persona.
  // Returns false when the agent or its provider/model is unavailable.
  async changeAgent(agentId?: string) {
    if (!this.provider) throw new Error("Session not initialized");
    this.ensureAgentRegistry();

    const id =
      agentId ??
      (await select(
        "Select the agent:",
        this.agentRegistry.list().map((agent) => agent.id),
      ));

    const agent = this.agentRegistry.get(id);
    if (!agent) {
      logger.warn(`Unknown agent: ${id}`);
      return false;
    }

    const providerName =
      agent.provider ?? this.providerName ?? this.config.config.defaultProvider;
    const model =
      agent.model ??
      (providerName === this.providerName ? this.model : undefined) ??
      this.config.config.model;
    if (!providerName || !model) return false;

    if (providerName !== this.providerName || model !== this.model) {
      const providerConfig = this.config.config.providers[providerName];
      if (!providerConfig) return false;

      try {
        const provider = this.createProvider(providerName, providerConfig, model);
        await provider.initialize();
        if (!provider.setModel(model)) return false;

        this.provider = provider;
        this.providerName = providerName;
        this.model = provider.getModel();
      } catch (err) {
        logger.warn({ err }, `Failed to switch to agent ${agent.id}`);
        return false;
      }
    }

    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools);
    this.applySystemPrompt(true);

    await this.initializeClassifier();

    this.save();
    return true;
  }

  // Compacts the session history using the configured threshold.
  async compactSession() {
    if (!this.provider) throw new Error("Session not initialized");

    const before = this.history;
    this.history = compactHistory(
      this.history,
      this.config.config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
      this.provider.getContextWindow(),
    );
    const changed = this.history !== before;

    if (changed) {
      this.provider.resetContextUsage();
      this.save();
    }
    return changed;
  }

  // Classifies the prompt and dispatches it to text or image generation.
  async ask(prompt: string) {
    if (!this.provider) throw new Error("Session not initialized");

    const action = await this.classifyAction(prompt);

    const response =
      action === "imageGeneration"
        ? await this.provider.generateImage(prompt)
        : await this.runAgentLoop(prompt);

    this.recordUsage(response);
    this.save();
    await this.maybeAutoCompact();
    return response;
  }

  // ReAct loop: LLM -> tool calls -> tool results -> repeat, capped by
  // tools.maxIterations so a confused model cannot spin forever.
  protected async runAgentLoop(prompt: string): Promise<AgentResponse> {
    const provider = this.provider;
    if (!provider) throw new Error("Session not initialized");

    const toolsConfig = this.config.config.tools;
    const configuredMax = Math.max(1, toolsConfig?.maxIterations ?? 8);
    const maxIterations = this.agent?.maxIterations
      ? Math.min(configuredMax, this.agent.maxIterations)
      : configuredMax;
    const specs = toolsConfig?.enabled === false ? [] : this.tools.specs();

    this.history.push({ role: "user", content: prompt });

    const usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let costUsd = 0;
    let lastText = "";

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const result = await provider.chat(this.history, { tools: specs });

      this.addUsage(usage, result.usage);
      costUsd += result.costUsd ?? 0;
      lastText = result.turn.text;
      this.appendAssistant(result.turn.text, result.turn.toolCalls);

      const readyToAnswer =
        result.turn.finishReason !== "toolCalls" ||
        result.turn.toolCalls.length === 0;

      if (readyToAnswer) {
        return { text: result.turn.text, usage, costUsd };
      }

      for (const call of result.turn.toolCalls) {
        const toolResult = await this.runTool(call);
        this.history.push({
          role: "tool",
          toolCallId: call.id,
          content: toolResult.output,
        });
      }
    }

    return {
      text: lastText || "Stopped: maximum tool iterations reached",
      usage,
      costUsd,
    };
  }

  // Tool calls run sequentially in v1 so ordering and logs stay predictable.
  protected async runTool(call: ToolCall): Promise<ToolResult> {
    logger.info(`Tool call: ${call.name} ${this.preview(call.args)}`);

    const result = await this.tools.execute(this.toolContext(), call);

    if (result.isError) {
      logger.warn(`Tool ${call.name} failed: ${this.preview(result.output)}`);
    }

    return result;
  }

  protected appendAssistant(text: string, toolCalls: ToolCall[]) {
    const message: Extract<History, { role: "assistant" }> = {
      role: "assistant",
      content: text,
    };
    if (toolCalls.length) message.toolCalls = toolCalls;

    this.history.push(message);
  }

  protected toolContext(): ToolContext {
    return {
      cwd: this.config.config.tools?.workspace ?? process.cwd(),
      sessionId: this.sessionId,
      approve: (command) => this.approve(command),
    };
  }

  // Approval gate for side effects. "auto" trusts the model (v1 default);
  // "deny" blocks everything; "ask" prompts the user when a tool needs it.
  protected async approve(command: string): Promise<boolean> {
    const globalMode = this.config.config.tools?.approval ?? "auto";
    const mode = this.agent?.approval
      ? strictestApproval(globalMode, this.agent.approval)
      : globalMode;
    if (mode === "auto") return true;
    if (mode === "deny") return false;

    const answer = await input(`Allow command? ${command} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  }

  protected preview(value: unknown) {
    const text =
      typeof value === "string" ? value : JSON.stringify(value ?? {});
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }

  protected addUsage(total: TokenUsage, usage?: TokenUsage) {
    if (!usage) return;

    total.promptTokens += usage.promptTokens;
    total.completionTokens += usage.completionTokens;
    total.totalTokens += usage.totalTokens;
  }

  // Current session usage, cost and context occupancy.
  status(): SessionStatus {
    const contextWindow = this.provider?.getContextWindow();
    const contextTokens =
      this.provider?.getContextTokens() || estimateHistoryTokens(this.history);
    const contextUsage = contextWindow
      ? Math.min(contextTokens / contextWindow, 1)
      : 0;

    return {
      sessionId: this.sessionId,
      agent: this.agentId,
      provider: this.providerName,
      model: this.model,
      usage: { ...this.usage },
      costUsd: this.costUsd,
      contextTokens,
      contextWindow,
      contextUsage,
      autoCompact: this.config.config.autoCompact ?? true,
      autoCompactThreshold: this.config.config.autoCompactThreshold ?? 60,
    };
  }

  protected recordUsage(response: AgentResponse) {
    if (response.usage) {
      this.usage.inputTokens += response.usage.promptTokens;
      this.usage.outputTokens += response.usage.completionTokens;
      this.usage.totalTokens += response.usage.totalTokens;
    }

    if (typeof response.costUsd === "number") {
      this.costUsd += response.costUsd;
    }
  }

  protected async maybeAutoCompact() {
    const { autoCompact, autoCompactThreshold } = this.config.config;
    if (autoCompact === false) return;

    const threshold = autoCompactThreshold ?? 60;
    const status = this.status();
    if (!status.contextWindow) return;
    if (status.contextUsage * 100 < threshold) return;

    const compacted = await this.compactSession();
    if (compacted) {
      logger.info(
        `Context at ${Math.round(status.contextUsage * 100)}% (threshold ${threshold}%), session compacted`,
      );
    }
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

  // Loads markdown agent definitions from disk, replacing the embedded-only
  // registry. Safe to call once per session initialization.
  protected loadAgentRegistry() {
    this.agentRegistry = new AgentLoader(
      this.config.config.agents?.dir,
    ).load();
    this.agentsLoaded = true;
  }

  protected ensureAgentRegistry() {
    if (!this.agentsLoaded) this.loadAgentRegistry();
  }

  // Resolves an agent id, warning and falling back to the default when the
  // requested definition is missing.
  protected resolveAgent(agentId?: string): AgentDefinition {
    if (agentId && !this.agentRegistry.has(agentId)) {
      logger.warn(`Unknown agent "${agentId}", using default`);
    }

    return this.agentRegistry.resolve(agentId) ?? builtInDefaultAgent();
  }

  // Injects the active agent persona as the first system message. When
  // replacing, only an existing leading system message is overwritten so
  // compacted-memory blocks are preserved.
  protected applySystemPrompt(replace = false) {
    const agent = this.agent ?? builtInDefaultAgent();
    const message: History = {
      role: "system",
      content: composeSystemPrompt(agent),
    };

    if (replace && this.history[0]?.role === "system") {
      this.history[0] = message;
      return;
    }

    this.history.unshift(message);
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
