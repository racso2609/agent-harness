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
import { Config, DEFAULT_PROVIDER_TYPE, ProviderDetail } from "@/configuration";
import { OpenAiProvider } from "@/providers/openai";
import { ensureSkillsDir, SkillLoader, SkillRegistry } from "@/skills";
import type { SkillSummary } from "@/skills";
import { createToolRegistry, ToolContext, ToolRegistry } from "@/tools";
import type { ApprovalDecision, ApprovalRequest } from "@/tools";
import {
  AgentResponse,
  ChatEventListener,
  History,
  Provider,
  TokenUsage,
  TurnOutcome,
  ToolCall,
  ToolResult,
} from "@/types/providers";
import { SessionStatus, SessionSummary, SessionUsage } from "@/types/session";
import { generateSessionId } from "@/utils/session";
import { logger } from "@/utils/logger";
import type { ApprovalHandler } from "@/contract";
import { ClassifiedAction, classifyAction } from "./classifyAction";
import { compactHistory, DEFAULT_COMPACT_THRESHOLD, estimateHistoryTokens } from "./history";
import { SessionRecord, SessionStore } from "./SessionStore";
import { SpawnEventListener, SpawnHandle, SpawnManager } from "./spawn";

// Options accepted by initialize/load to resume an existing session.
export interface SessionOptions {
  // Id of a previously persisted session to resume.
  sessionId?: string;
  // Agent to use when starting a new session.
  agent?: string;
  // Store used for persistence; defaults to a new SessionStore.
  store?: SessionStore;
}

// Options for spawning a background child agent.
export interface SpawnOptions {
  // Extra context prepended to the child's prompt.
  context?: string;
}

// Registry mapping a backend type (the `type` field of a provider entry) to a
// factory that builds the concrete Provider implementation. Provider entries
// are keyed by a free-form instance id, so several entries can share a type.
const PROVIDER_FACTORIES: Record<
  string,
  (config: { url: string; apikey: string }, model: string) => Provider
> = {
  openai: (config, model) => new OpenAiProvider(config.url, config.apikey, model),
};

// Resolves the backend type of a provider entry, defaulting to "openai" so
// configs written before instance ids existed keep working.
const providerType = (config: { type?: string }) => config.type ?? DEFAULT_PROVIDER_TYPE;

const applyProviderOptions = (provider: Provider, config: Config, type: string) => {
  if (type !== "openai") return provider;

  const openai = provider as OpenAiProvider;
  openai.normalizeTextToolCalls = config.config.tools?.normalizeTextToolCalls ?? true;
  return provider;
};

// Caps a string for injection into history, marking the elision.
const truncateText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

// A settled child can come back with nothing useful: undefined (never set) and
// an empty or blank string are the same case for the parent, so both fall back
// to a placeholder instead of injecting a blank system message.
const outcomeText = (value: string | undefined, fallback: string) =>
  value && value.trim() ? value : fallback;

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
  // Lists persisted sessions, newest activity first.
  listSessions: () => SessionSummary[];
  // Resolves a full id, a unique id prefix or a 1-based list index.
  resolveSession: (target: string) => string | undefined;
  // Persists the current session state to the store.
  save: () => void;
  // Lists the provider instances keyed in the config.
  listProviders: () => string[];
  // Lists the provider instances with their id, backend type and default flag.
  listProviderDetails: () => ProviderDetail[];
  // Creates or replaces a provider instance and persists the config.
  configureProvider: (
    id: string,
    provider: { type?: string; url: string; apikey: string; model?: string },
    options?: { makeDefault?: boolean },
  ) => void;
  // Removes a provider instance and persists the config.
  removeProvider: (id: string) => boolean;
  // Swaps the active provider, keeping the current model when possible.
  setProvider: (name: string) => Promise<boolean>;
  // Swaps the model of the active provider.
  setModel: (model: string) => boolean;
  // Lists the agents available from the agents directory.
  listAgents: () => AgentSummary[];
  // Swaps the active agent, its tools and its persona.
  setAgent: (agentId: string) => Promise<boolean>;
  // Installs the handler used when the approval policy is "ask".
  approveWith: (handler: ApprovalHandler) => void;
  // Launches a background child agent. Returns a handle immediately.
  spawn: (agentId: string, prompt: string, options?: SpawnOptions) => SpawnHandle;
  // Returns a snapshot of a background child, or undefined when unknown.
  pollSpawn: (spawnId: string) => SpawnHandle | undefined;
  // Lists every background child spawned by this session.
  listSpawns: () => SpawnHandle[];
  // Children of this session, persisted across runs. Read-only after /resume.
  childHistory: () => SpawnHandle[];
  // Settled children whose result has not entered a parent turn yet.
  pendingSpawns: () => SpawnHandle[];
  // Waits for a background child to settle.
  waitSpawn: (spawnId: string) => Promise<SpawnHandle | undefined>;
  // Waits for every child (or the given ids) and returns their handles.
  collectSpawns: (spawnIds?: string[]) => Promise<SpawnHandle[]>;
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
  // Skill definitions loaded from config.skills.dirs; undefined when disabled.
  skillRegistry?: SkillRegistry;
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
  // Parent session id when this session is a background-spawned child.
  parentId?: string;
  // Accumulated token usage for this session.
  usage: SessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  // Accumulated cost in USD for this session.
  costUsd = 0;
  // Subjects the user chose to "always allow" for the rest of the session.
  protected alwaysAllowed = new Set<string>();
  // Injected handler for interactive approvals. Undefined means deny.
  protected approvalHandler?: ApprovalHandler;
  // Background child agents launched by this session. Created lazily.
  protected spawns?: SpawnManager;
  // Children this session launched, kept in launch order so the transcript
  // survives /resume. Restored read-only: children are never reattached.
  protected spawnHistory: SpawnHandle[] = [];
  // Children that already settled but whose result has not been handed to a
  // parent turn yet, in settlement order. The push into history is what marks
  // a child as delivered, so there is no per-child flag.
  protected undelivered: SpawnHandle[] = [];

  constructor(config = new Config(), store = new SessionStore()) {
    this.config = config;
    this.store = store;
    this.tools = createToolRegistry(this.config, undefined, {
      skills: this.skillRegistry,
    });
    this.createdAt = new Date().toISOString();
  }

  // Initializes the session from the persisted config:
  // creates the provider, loads its model list and applies the default model.
  // When options.sessionId is given, the stored session is resumed instead.
  async initialize(options: SessionOptions = {}) {
    if (options.store) this.store = options.store;

    this.loadAgentRegistry();

    this.loadSkillRegistry();

    const agent = this.resolveAgent(options.agent ?? this.config.config.agents?.default);
    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools, {
      skills: this.skillRegistry,
    });

    const providerName = agent.provider ?? this.config.config.defaultProvider;
    if (!providerName) throw new Error("No default provider configured");

    const providerConfig = this.config.config.providers[providerName];
    if (!providerConfig) throw new Error(`Missing config for ${providerName}`);

    const model = agent.model ?? providerConfig.model ?? this.config.config.model;
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

    const provider = this.createProvider(record.provider, providerConfig, record.model);
    await provider.initialize();
    if (!provider.setModel(record.model)) return false;

    this.loadSkillRegistry();

    const agent = this.resolveAgent(record.agentId ?? this.config.config.agents?.default);
    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools, {
      skills: this.skillRegistry,
    });

    this.history = record.history ?? [];
    // Children from a previous run are history only: they cannot be
    // reattached, and their status is whatever it was when persisted.
    this.spawnHistory = record.spawns ?? [];
    // Sessions persisted with an agent already start with its persona. Older
    // sessions keep their system messages (e.g. compacted memory) untouched.
    this.applySystemPrompt(Boolean(record.agentId));

    this.id = record.id;
    this.sessionId = record.id;
    this.createdAt = record.createdAt;
    this.parentId = record.parentId;
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

  // Lists persisted sessions, newest activity first.
  listSessions(): SessionSummary[] {
    return this.store.list().map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      provider: record.provider,
      model: record.model,
      agentId: record.agentId,
      messageCount: record.history?.length ?? 0,
      title: this.sessionTitle(record.history),
    }));
  }

  // Accepts a full id, a unique id prefix or a 1-based list index.
  resolveSession(target: string) {
    const sessions = this.listSessions();
    const value = target.trim();
    if (!value) return undefined;

    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
      return sessions[index - 1].id;
    }

    const exact = sessions.find((session) => session.id === value);
    if (exact) return exact.id;

    const matches = sessions.filter((session) => session.id.startsWith(value));
    return matches.length === 1 ? matches[0].id : undefined;
  }

  // Builds a short title from the first user message of a session.
  protected sessionTitle(history: History[]) {
    const message = history.find((entry) => entry.role === "user" && entry.content.trim());
    if (!message) return undefined;

    const text = message.content.replace(/\s+/g, " ").trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
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
      parentId: this.parentId,
      history: this.history,
      usage: this.usage,
      costUsd: this.costUsd,
      spawns: this.spawnHistory.length ? this.spawnHistory : undefined,
    };

    this.store.save(record);
  }

  // Lists the provider instances keyed in the config.
  listProviders() {
    return this.config.listProviders();
  }

  // Lists the provider instances with their id, backend type and default flag.
  listProviderDetails() {
    return this.config.listProviderDetails();
  }

  // Creates or replaces a provider instance and persists the config.
  configureProvider(
    id: string,
    provider: { type?: string; url: string; apikey: string; model?: string },
    options: { makeDefault?: boolean } = {},
  ) {
    this.config.configureProvider(id, provider, options);
    this.config.writeConfig();
  }

  // Removes a provider instance (and persists the config).
  removeProvider(id: string) {
    const removed = this.config.removeProvider(id);
    if (removed) this.config.writeConfig();
    return removed;
  }

  // Replaces the active provider, keeping the current model when possible.
  // Returns false when the target provider or model is unavailable.
  async setProvider(name: string) {
    if (!this.provider) throw new Error("Session not initialized");

    const providerConfig = this.config.config.providers[name];
    if (!providerConfig) return false;

    const provider = this.createProvider(
      name,
      providerConfig,
      this.model ?? providerConfig.model ?? this.config.config.model ?? "",
    );
    await provider.initialize();

    if (!this.selectModel(provider, providerConfig)) return false;

    this.provider = provider;
    this.providerName = name;
    this.model = provider.getModel();

    await this.initializeClassifier();

    this.save();
    return true;
  }

  // Changes the model of the active provider and persists it to the config.
  // Returns false when the model is not offered by the provider.
  setModel(model: string) {
    if (!this.provider) throw new Error("Session not initialized");

    if (!this.provider.setModel(model)) return false;

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

  // Skills visible to this session, for CLI listings and diagnostics.
  listSkills(): SkillSummary[] {
    return this.skillRegistry?.summaries() ?? [];
  }

  // Re-scans the skills directories and recomposes the system prompt so a
  // reload is visible without restarting the session.
  reloadSkills(): SkillSummary[] {
    this.loadSkillRegistry();
    if (this.agent) this.applySystemPrompt(true);
    return this.listSkills();
  }

  // Swaps the active agent and applies its provider, model, tools and persona.
  // Returns false when the agent or its provider/model is unavailable.
  async setAgent(agentId: string) {
    if (!this.provider) throw new Error("Session not initialized");
    this.ensureAgentRegistry();

    const agent = this.agentRegistry.get(agentId);
    if (!agent) {
      logger.warn(`Unknown agent: ${agentId}`);
      return false;
    }

    const providerName = agent.provider ?? this.providerName ?? this.config.config.defaultProvider;
    if (!providerName) return false;

    // Injected sessions may have a provider without a config entry (unit tests,
    // embedders); keep the current model in that case instead of failing.
    const switching = providerName !== this.providerName;
    const providerConfig = this.config.config.providers[providerName];
    if (!providerConfig && switching) return false;

    const model =
      agent.model ??
      (switching ? undefined : this.model) ??
      providerConfig?.model ??
      this.config.config.model ??
      "";
    if (!model) return false;
    if (switching || model !== this.model) {
      try {
        const provider = this.createProvider(providerName, providerConfig ?? {}, model);
        await provider.initialize();
        if (!this.selectModel(provider, providerConfig ?? {})) return false;

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
    this.tools = createToolRegistry(this.config, agent.tools, {
      skills: this.skillRegistry,
    });
    this.applySystemPrompt(true);

    await this.initializeClassifier();

    this.save();
    return true;
  }

  // Launches a background child agent that runs its own isolated session and
  // persists with parentId pointing back here. Returns a handle immediately;
  // use pollSpawn/waitSpawn/collectSpawns to observe the result.
  spawn(agentId: string, prompt: string, options: SpawnOptions = {}): SpawnHandle {
    if (this.config.config.sessions?.spawnEnabled === false) {
      throw new Error("Spawning is disabled (sessions.spawnEnabled = false)");
    }

    const handle = this.spawnManager().spawn({
      agentId,
      sessionId: this.sessionId,
      prompt,
      context: options.context,
    });

    this.spawnHistory = [...this.spawnHistory, handle];

    return handle;
  }

  pollSpawn(spawnId: string) {
    return this.spawns?.poll(spawnId);
  }

  listSpawns() {
    return this.spawns?.list() ?? [];
  }

  // Children this session launched, including the ones restored from a
  // previous run. listSpawns() is the live view (this process only); this is
  // the persisted transcript, in launch order and read-only after a resume.
  childHistory(): SpawnHandle[] {
    return [...this.spawnHistory];
  }

  // Children already settled (done or error) whose result has not entered a
  // parent turn yet, in settlement order. Reading it does not drain the list:
  // it is a copy, and only flushPendingSpawns() delivers the results.
  pendingSpawns(): SpawnHandle[] {
    return [...this.undelivered];
  }

  waitSpawn(spawnId: string) {
    if (!this.spawns) return Promise.resolve(undefined);
    return this.spawns.wait(spawnId);
  }

  collectSpawns(spawnIds?: string[]) {
    if (!this.spawns) return Promise.resolve([]);
    return this.spawns.collect(spawnIds);
  }

  // Subscribes an external consumer (the CLI UI) to spawn lifecycle events.
  // Live only: past events are not replayed, read listSpawns() for the current
  // state. The manager is built here so a listener registered before the first
  // spawn still receives it.
  onSpawnEvent(listener: SpawnEventListener): () => void {
    return this.spawnManager().on(listener);
  }

  // Builds the spawn manager on first use. The runner spins up a fresh child
  // SessionManager per spawn so history, usage and provider state stay
  // isolated from the parent turn.
  protected spawnManager(): SpawnManager {
    if (this.spawns) return this.spawns;

    this.spawns = new SpawnManager({
      maxChildren: this.config.config.sessions?.maxChildren,
      timeoutMs: this.config.config.sessions?.childTimeoutMs,
      runner: async ({ sessionId, agentId, prompt, context, signal }) => {
        const child = new SessionManagerImpl(this.config, this.store);
        child.parentId = sessionId;
        await child.initialize({ agent: agentId, store: this.store });
        if (this.approvalHandler) child.approveWith(this.approvalHandler);

        if (signal.aborted) throw new Error("Spawn aborted");

        const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
        return child.ask(fullPrompt);
      },
    });

    // When a child settles, queue only its final answer for the parent as a
    // system message so the next turn can take it into account. The full child
    // history is never shared; the text is capped to avoid inflating context.
    // Delivery waits for the next parent turn, so pendingSpawns() can report
    // what is still unread.
    this.spawns.on((event) => {
      if (event.type !== "settled") return;

      // Keep the persisted history in sync with the real outcome.
      this.spawnHistory = this.spawnHistory.map((entry) =>
        entry.spawnId === event.handle.spawnId ? event.handle : entry,
      );
      // Queue the result for the next parent turn, replacing any previous entry
      // for the same child so a re-settle cannot enqueue it twice.
      this.undelivered = [
        ...this.undelivered.filter((entry) => entry.spawnId !== event.handle.spawnId),
        event.handle,
      ];
      // A child can finish without another turn, so persist here too.
      this.save();
    });

    return this.spawns;
  }

  // Hands every queued child result to the parent as a system message, in
  // settlement order. The push into history is the delivery marker, so the
  // queue is drained in one go.
  protected flushPendingSpawns() {
    if (!this.undelivered.length) return;

    const pending = this.undelivered;
    this.undelivered = [];
    for (const handle of pending) {
      this.history.push({
        role: "system",
        content: this.formatSpawnResult(handle),
      });
    }
    // Persist as soon as the results are delivered, not only at the end of the
    // turn: the queue is drained here, so a turn that throws after the flush
    // (provider error, abort, tool exception) would leave the message in memory
    // only, and a restart would lose the child result for good. One save for
    // the whole batch; the early return above keeps an empty queue from saving.
    this.save();
  }

  // Builds the compact system message injected into the parent's history once
  // a child finishes. Only the final (truncated) text is included.
  protected formatSpawnResult(handle: SpawnHandle): string {
    const max = this.config.config.sessions?.childResultMaxChars ?? 2000;
    const header = `[spawn ${handle.spawnId} · ${handle.agentId} · ${handle.status}]`;

    if (handle.status === "error") {
      return `${header} ${truncateText(outcomeText(handle.error, "unknown error"), max)}`;
    }
    return `${header}\n${truncateText(outcomeText(handle.result, "(no output)"), max)}`;
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
  async ask(prompt: string, onEvent?: ChatEventListener) {
    if (!this.provider) throw new Error("Session not initialized");

    // Deliver before the turn reads history, so the parent starts the turn
    // with the child results already in context instead of mid-conversation.
    this.flushPendingSpawns();

    const action = await this.classifyAction(prompt);

    const response =
      action === "imageGeneration"
        ? await this.provider.generateImage(prompt)
        : await this.runAgentLoop(prompt, onEvent);

    this.recordUsage(response);
    this.save();
    await this.maybeAutoCompact();
    return response;
  }

  // ReAct loop: LLM -> tool calls -> tool results -> repeat, capped by
  // tools.maxIterations so a confused model cannot spin forever.
  protected async runAgentLoop(
    prompt: string,
    onEvent?: ChatEventListener,
  ): Promise<AgentResponse> {
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

    // Work the turn could not finish, surfaced in the response outcome so the
    // caller can report it without parsing text.
    const failedTools: string[] = [];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const result = await provider.chat(this.history, { tools: specs, onEvent });

      this.addUsage(usage, result.usage);
      costUsd += result.costUsd ?? 0;
      lastText = result.turn.text;
      this.appendAssistant(result.turn.text, result.turn.toolCalls);

      const readyToAnswer =
        result.turn.finishReason !== "toolCalls" || result.turn.toolCalls.length === 0;

      if (readyToAnswer) {
        return {
          text: result.turn.text,
          usage,
          costUsd,
          outcome: this.outcomeOf(failedTools),
        };
      }

      for (const call of result.turn.toolCalls) {
        const toolResult = await this.runTool(call, onEvent);
        if (toolResult.isError) failedTools.push(call.name);
        const content = toolResult.isError
          ? `[tool error] ${toolResult.output}`
          : toolResult.output;
        this.history.push({
          role: "tool",
          toolCallId: call.id,
          content,
        });
      }
    }

    return {
      text: lastText || "Stopped: maximum tool iterations reached",
      usage,
      costUsd,
      outcome: {
        status: "incomplete",
        pending: [...failedTools, "finish the turn within tools.maxIterations"],
        next: "Reply with a smaller scope, or raise tools.maxIterations.",
      },
    };
  }

  // Tool calls run sequentially in v1 so ordering and logs stay predictable.
  // Builds the structured outcome for a turn that reached its answer.
  protected outcomeOf(failedTools: string[]): TurnOutcome {
    if (failedTools.length) {
      return {
        status: "toolError",
        pending: failedTools,
        next: "Review the failing tool output and retry.",
      };
    }

    return { status: "completed", pending: [] };
  }

  protected async runTool(call: ToolCall, onEvent?: ChatEventListener): Promise<ToolResult> {
    logger.info(`Tool call: ${call.name} ${this.preview(call.args)}`);

    const result = await this.tools.execute(this.toolContext(call, onEvent), call);

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

  protected toolContext(call?: ToolCall, onEvent?: ChatEventListener): ToolContext {
    return {
      cwd: this.config.config.tools?.workspace ?? process.cwd(),
      sessionId: this.sessionId,
      approve: (request) => this.approve(request),
      spawn: (agentId, prompt) => this.spawn(agentId, prompt),
      getSkillBody: (id) => this.skillBody(id),
      listSkillIds: () => this.skillIds(),
      // Streams shell/tool output live, tagged with the originating call so the
      // UI can attribute it.
      onOutput: (chunk) => {
        if (!call) return;
        onEvent?.({ type: "toolOutput", id: call.id, name: call.name, chunk });
      },
    };
  }

  // Ids of the loaded skills, so use_skill can list them on a bad id.
  protected skillIds(): string[] {
    return this.skillRegistry?.list().map((skill) => skill.id) ?? [];
  }

  // Body handed to use_skill, capped by skills.maxBodyChars so a long
  // recipe cannot swallow the turn.
  protected skillBody(id: string): string | undefined {
    const skill = this.skillRegistry?.get(id);
    if (!skill) return undefined;

    const max = this.config.config.skills?.maxBodyChars ?? 16_000;
    if (skill.body.length <= max) return skill.body;

    return `${skill.body.slice(0, max)}\n[skill truncated]`;
  }

  // Approval gate. The effective mode is the strictest of the configured
  // global policy and the active agent's policy:
  //   auto  -> reads allowed, writes/exec allowed unless denied by policy
  //   ask   -> reads allowed, writes/exec prompt the user
  //   deny  -> only reads allowed
  // Commands matching a deny pattern are always rejected.
  protected async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const globalMode = this.config.config.tools?.approval ?? "auto";
    const mode = this.agent?.approval
      ? strictestApproval(globalMode, this.agent.approval)
      : globalMode;

    if (request.kind === "read") return "allow";
    if (mode === "deny") return "deny";

    const key = `${request.kind}:${request.subject}`;
    if (this.alwaysAllowed.has(key)) return "allow";

    if (mode === "auto") {
      this.alwaysAllowed.add(key);
      return "allow";
    }

    if (!this.approvalHandler) {
      logger.warn("Approval required but no handler installed; denying");
      return "deny";
    }

    const decision = await this.approvalHandler(request);
    if (decision === "always") {
      this.alwaysAllowed.add(key);
      return "allow";
    }
    return decision;
  }

  // Installs the handler used when the approval policy is "ask".
  approveWith(handler: ApprovalHandler) {
    this.approvalHandler = handler;
  }

  protected preview(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
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
    const contextTokens = this.provider?.getContextTokens() || estimateHistoryTokens(this.history);
    const contextUsage = contextWindow ? Math.min(contextTokens / contextWindow, 1) : 0;

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
    const name = this.config.config.classificationProvider ?? this.providerName;
    const model = this.config.config.classificationModel ?? this.config.config.model;

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
  // registry. Seeds the runtime directory with the bundled examples first so a
  // clean install ships with the default agents. Safe to call once.
  protected loadAgentRegistry() {
    const loader = new AgentLoader(this.config.config.agents?.dir);
    loader.seed();
    this.agentRegistry = loader.load();
    this.agentsLoaded = true;
  }

  // Loads the skill registry from config.skills.dirs. Disabled skills leave it
  // undefined, which keeps the system prompt byte-identical to older builds.
  protected loadSkillRegistry() {
    if (this.config.config.skills?.enabled === false) {
      this.skillRegistry = undefined;
      return;
    }

    const dirs = this.config.config.skills?.dirs ?? [];
    const [primary] = dirs;
    // Copy the bundled examples on a clean install, mirroring the agent
    // seed: an existing directory is never touched.
    if (primary) ensureSkillsDir(primary);

    this.skillRegistry = new SkillLoader(dirs).load();
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
      content: composeSystemPrompt(
        agent,
        this.skillRegistry?.indexText(this.config.config.skills?.maxIndexChars),
      ),
    };

    if (replace && this.history[0]?.role === "system") {
      this.history[0] = message;
      return;
    }

    this.history.unshift(message);
  }

  // Applies the model the caller asked for; when the instance does not offer
  // it, falls back to the instance's preferred model and finally to the first
  // model it advertises, so switching between instances with different
  // catalogues keeps working.
  protected selectModel(provider: Provider, providerConfig: { model?: string }): boolean {
    if (provider.setModel(provider.getModel())) return true;

    let available: string[] = [];
    try {
      available = provider.listModels?.().map((model) => model.id) ?? [];
    } catch {
      // A provider that has not loaded its catalogue just keeps the fallbacks.
    }

    const candidates = [providerConfig.model, ...available].filter((model): model is string =>
      Boolean(model),
    );

    for (const candidate of candidates) {
      if (provider.setModel(candidate)) return true;
    }

    return false;
  }

  // Resolves the factory for the given provider instance id and instantiates it.
  protected createProvider(
    name: string,
    config: { type?: string; url: string; apikey: string },
    model: string,
  ) {
    const type = providerType(config);
    const factory = PROVIDER_FACTORIES[type];
    if (!factory) throw new Error(`Unsupported provider type: ${type}`);
    return applyProviderOptions(factory(config, model), this.config, type);
  }
}

export { SessionManagerImpl as SessionManager };
export type { SessionManager as SessionManagerContract };
