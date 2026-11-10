import fs from "node:fs";
import nodePath from "node:path";

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
import {
  composeMemoryBlock,
  createMemoryProvider,
  redact,
  resolveProjectIdentity,
  stripMemoryBlocks,
} from "@/memory";
import type {
  MemoryHit,
  MemoryObservation,
  MemoryProvider,
  MemoryScope,
  ProjectIdentity,
} from "@/memory";

import { OpenAiProvider } from "@/providers/openai";
import { ensureSkillsDir, SkillLoader, SkillRegistry } from "@/skills";
import type { SkillSummary } from "@/skills";
import { McpManager } from "@/mcp";
import type { McpServerSummary, McpToolSummary } from "@/mcp";
import { createToolRegistry, ToolContext, ToolRegistry } from "@/tools";
import { isInsideRealWorkspace, spawnArtifactPath, workspaceRoot } from "@/tools/paths";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ForgetResult,
  RememberInput,
  RememberResult,
} from "@/tools";
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
import { ConversationEntry, SessionStatus, SessionSummary, SessionUsage } from "@/types/session";
import { generateSessionId } from "@/utils/session";
import { logger } from "@/utils/logger";
import type { ApprovalHandler } from "@/contract";
import { ClassifiedAction, classifyAction } from "./classifyAction";
import {
  compactHistoryWithSummary,
  DEFAULT_COMPACT_THRESHOLD,
  estimateHistoryTokens,
} from "./history";
import { SessionRecord, SessionStore } from "./SessionStore";
import {
  childResultBudget,
  outcomeText,
  SpawnEventListener,
  SpawnHandle,
  SpawnManager,
  summarize,
} from "./spawn";

// Options accepted by initialize/load to resume an existing session.
// Options of a turn started by the session itself (never by IHarness.ask,
// whose signature stays put). `signal` is handed down by the spawn runner:
// aborting it is what cancels a child mid-request.
interface AskTurnOptions {
  unprompted?: true;
  signal?: AbortSignal;
}

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

// Line of the delivery message that tells the parent the whole report is in
// the artifact and that guessing instead of reading is not an option: the
// dangerous failure is not the truncation itself but a parent that decides on
// text it never read.
const ARTIFACT_INSTRUCTION =
  "Es obligatorio leer ese fichero antes de decidir; si no puedes leerlo, dilo y no supongas su contenido.";

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
  // One entry per configured MCP server, with the state of its connection.
  listMcpServers: () => McpServerSummary[];
  // Every MCP tool discovered so far, as a listing shows it.
  mcpTools: () => McpToolSummary[];
  // Closes every MCP connection, forgets them and discovers again.
  reloadMcp: () => Promise<McpServerSummary[]>;
  // Closes every MCP connection. The harness calls it on shutdown.
  closeMcp: () => Promise<void>;
  // Releases the memory backend. The harness calls it on shutdown, after
  // the MCP close.
  closeMemory: () => Promise<void>;
  // Lists the agents available from the agents directory.
  listAgents: () => AgentSummary[];
  // Swaps the active agent, its tools and its persona.
  setAgent: (agentId: string) => Promise<boolean>;
  // Health of the configured memory backend, for diagnostics.
  memoryStatus: () => Promise<{
    provider: string;
    ok: boolean;
    detail?: string;
    project?: string;
    projectSource?: string;
  }>;
  // Searches the persistent memory. Empty when memory is off or down.
  searchMemory: (query: string, limit?: number) => Promise<MemoryHit[]>;
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
  ask: (
    prompt: string,
    onEvent?: ChatEventListener,
    options?: AskTurnOptions,
  ) => Promise<AgentResponse>;
  // internal
  // la idea es agharrar el propmt pasaarlo por un agent peque;o que no consuma mucho y preguntarle que tipo de accion es textGeneration or imageGeneration para luego enrutarlo a la accion correcta del provider (jev)
  classifyAction: (prompt: string, signal?: AbortSignal) => Promise<ClassifiedAction>;
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
  // Owner of the MCP connections of this session tree. Always built, even
  // when MCP is off: the constructor only reads the `mcp` block and spawns
  // nothing, so it costs no process and no I/O. The gate on `mcp.enabled` and
  // on RACSO_HARNESS_MCP_DISABLED lives in createToolRegistry, which is what
  // decides whether the provider is installed at all.
  //
  // One per session tree, not one per registry: initialize, load, setAgent and
  // the spawned children all reuse it, so the registries they rebuild never
  // open a second connection to the same server.
  mcp: McpManager;
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
  // a child as delivered, so the queue never holds the same one twice.
  protected undelivered: SpawnHandle[] = [];

  // Persistent memory backend. Created by initialize() from the memory config
  // block; until then a no-op, so every path can hold one.
  protected memoryProvider: MemoryProvider = createMemoryProvider(undefined);

  // Cached project identity. memoryProject() is called both when injecting the
  // memory block and on every recall, and resolving it shells out to git; the
  // workspace does not change during a session, so resolving once is enough.
  private projectIdentity: ProjectIdentity | null = null;
  // Workspace the cached identity was resolved for, so a changed workspace
  // invalidates it.
  private projectIdentityCwd: string | null = null;

  // Ids of the children whose result already entered the history. Persisted so
  // a resume does not hand the parent the same result twice: the injected
  // message itself is not a reliable marker, since history compaction may
  // drop it while the child stays settled.
  protected delivered = new Set<string>();

  constructor(config = new Config(), store = new SessionStore(), mcp?: McpManager) {
    this.config = config;
    this.store = store;
    // A child session reuses the manager of its parent, so a whole tree
    // shares one set of connections and closing the root closes them all.
    this.mcp = mcp ?? new McpManager({ mcp: config.config?.mcp });
    this.tools = createToolRegistry(this.config, undefined, {
      skills: this.skillRegistry,
      mcp: this.mcp,
    });
    this.createdAt = new Date().toISOString();
  }

  // Initializes the session from the persisted config:
  // creates the provider, loads its model list and applies the default model.
  // When options.sessionId is given, the stored session is resumed instead.
  async initialize(options: SessionOptions = {}) {
    if (options.store) this.store = options.store;

    // Built before any injection point: both load() and the new-session
    // branch below assume the provider already exists.
    this.memoryProvider = createMemoryProvider(this.config.config.memory);

    this.loadAgentRegistry();

    this.loadSkillRegistry();

    const agent = this.resolveAgent(options.agent ?? this.config.config.agents?.default);
    this.agent = agent;
    this.agentId = agent.id;
    this.tools = createToolRegistry(this.config, agent.tools, {
      skills: this.skillRegistry,
      mcp: this.mcp,
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
      await this.injectMemoryContext();
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
      mcp: this.mcp,
    });

    this.history = record.history ?? [];
    // Children from a previous run are history only: they cannot be
    // reattached, and their status is whatever it was when persisted.
    this.spawnHistory = record.spawns ?? [];

    // A settled child whose result never entered a parent turn is still owed
    // to the parent: queue it so the next turn delivers it. Children already
    // delivered are skipped, or /resume would inject their result twice. A
    // child still "running" died with the previous process and has no result
    // to hand over (the CLI already renders it as interrupted), so it is not
    // queued. Records written before deliveredSpawns existed read as "nothing
    // delivered", which is why SESSION_VERSION does not need to change: no
    // stored field changes meaning, and the worst case is an older result
    // delivered once more.
    const deliveredIds = new Set(record.deliveredSpawns ?? []);
    this.delivered = deliveredIds;
    // Only a done or error child carries a result for the parent, so only
    // those are re-queued: a cancelled one stays as history, never as pending
    // work, and a "running" one died with the previous process.
    const deliverable = (handle: SpawnHandle) =>
      handle.status === "done" || handle.status === "error";
    this.undelivered = this.spawnHistory.filter(
      (handle) => deliverable(handle) && !deliveredIds.has(handle.spawnId),
    );
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

    // Single injection point for resumed sessions: the history is
    // restored by now, so the block lands right after the persona.
    await this.injectMemoryContext();

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

  // Builds a short title from the first user message of a session. Unprompted
  // turns are skipped: nobody wrote them, so titling the session after an
  // automatic continuation would not describe it.
  protected sessionTitle(history: History[]) {
    const message = history.find(
      (entry) => entry.role === "user" && !entry.unprompted && entry.content.trim(),
    );
    if (!message) return undefined;

    const text = message.content.replace(/\s+/g, " ").trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  // Serializes the current state into the store, refreshing updatedAt.
  save() {
    if (!this.provider || !this.providerName || !this.model) return;

    // Only the children still in the transcript, so the list can never point at
    // a spawnId the record no longer carries. Empty means "nothing delivered",
    // which the next load reads the same as a missing field.
    const deliveredSpawns = this.spawnHistory
      .filter((handle) => this.delivered.has(handle.spawnId))
      .map((handle) => handle.spawnId);

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
      deliveredSpawns: deliveredSpawns.length ? deliveredSpawns : undefined,
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

  // One entry per configured MCP server, with the state of its connection.
  // Reading it never starts a server: `idle` is the state of one that was
  // never connected.
  listMcpServers(): McpServerSummary[] {
    // When the switch is off nothing was resolved, so an empty listing is the
    // honest answer: `/mcp` names the switch instead of showing idle servers.
    if (this.config.config.mcp?.enabled !== true) return [];

    return this.mcp.servers();
  }

  // Every MCP tool discovered so far, as a listing shows it.
  mcpTools(): McpToolSummary[] {
    return this.mcp.toolSummaries();
  }

  // Closes every MCP connection, forgets them and discovers again, returning
  // the state of the servers afterwards.
  //
  // This is the only way to recover from a server that failed: the manager
  // never retries on its own (a dead server would otherwise spawn a process on
  // every `tools()` call), and `invalidate` is the primitive that drops the
  // failure. It does NOT re-read config.json: the servers are the ones the
  // config held when the session was built, so a server added to the file needs
  // a restart.
  //
  // A closed manager answers `[]` and is left alone: close() is terminal
  // (shutdown() calls it), and discovering again would spawn the servers a
  // moment before the process leaves, which is exactly what close() prevents.
  //
  // The `isClosed()` check below is a belt, not the mechanism: a closed manager
  // already answers `[]` on its own, because `doClose()` empties the state every
  // reader walks. What the guard buys is the invariant surviving a `doClose` that
  // stops emptying it, and it is not what any test pins: drop it and the suite
  // stays green. The behaviour the tests hold is the outcome, an empty list and
  // no process, not the branch that produces it.
  async reloadMcp(): Promise<McpServerSummary[]> {
    // Not needed today (see above), kept so a reload cannot resurrect a close.
    if (this.mcp.isClosed()) return [];

    await this.mcp.invalidate();
    await this.mcp.ready();

    return this.mcp.servers();
  }

  // Closes every MCP connection of the session tree. Idempotent, and a no-op
  // when nothing was ever connected. The harness calls it from shutdown().
  closeMcp(): Promise<void> {
    return this.mcp.close();
  }

  // Releases the memory backend. Memory owns no child process, so this never
  // hangs; the harness calls it from shutdown(), after the MCP close.
  closeMemory(): Promise<void> {
    return this.memoryProvider.close();
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
      mcp: this.mcp,
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

  // Cancelling never builds the manager: a session that spawned nothing has
  // nothing to cancel, so it answers false instead of starting one to say no.
  cancelSpawn(spawnId: string): boolean {
    return this.spawns?.cancel(spawnId) ?? false;
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

  // Conversation as the UI reads it back, oldest first. Provider-only messages
  // (system persona, compaction memory, tool output) and assistant turns with
  // no text are filtered out here so every consumer sees the same thing.
  // Unprompted user turns are dropped too: they stay in the history because
  // the model must see them, but nobody typed them, so the UI hides them. The
  // filter lives here, once, instead of exposing the flag to every renderer.
  conversation(): ConversationEntry[] {
    return this.history.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      if (message.role === "user" && message.unprompted) return [];
      const content = message.content.trim();
      if (!content) return [];

      return [{ role: message.role, content }];
    });
  }

  // Children already settled (done or error) whose result has not entered a
  // parent turn yet, in settlement order. Reading it does not drain the list:
  // it is a copy, and only flushPendingSpawns() delivers the results. A
  // cancelled child never enters: there is no result to hand over.
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
      // The same budget the delivery formats with, so the settled handle
      // records the length of a report the parent will only see truncated.
      resultMaxChars: childResultBudget(this.config.config.sessions?.childResultMaxChars),
      runner: async ({ sessionId, agentId, prompt, context, signal }) => {
        const child = new SessionManagerImpl(this.config, this.store, this.mcp);
        child.parentId = sessionId;
        await child.initialize({ agent: agentId, store: this.store });
        if (this.approvalHandler) child.approveWith(this.approvalHandler);

        // Surface the manager's own abort reason (cancel or timeout) instead of a
        // message of our own: it is what tells the settlement point why it stopped.
        if (signal.aborted) throw signal.reason ?? new Error("Spawn aborted");

        const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
        // The signal travels with the turn so a cancel reaches the request that
        // is already in flight at the provider, instead of waiting for it to end.
        return child.ask(fullPrompt, undefined, { signal });
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
      // for the same child so a re-settle cannot enqueue it twice. A cancelled
      // child has nothing to deliver, so it is left out of the queue (and any
      // stale entry for it is dropped) while staying in the persisted history.
      const deliverable = event.handle.status === "done" || event.handle.status === "error";
      this.undelivered = [
        ...this.undelivered.filter((entry) => entry.spawnId !== event.handle.spawnId),
        ...(deliverable ? [event.handle] : []),
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
      this.delivered.add(handle.spawnId);
    }
    // Persist as soon as the results are delivered, not only at the end of the
    // turn: the queue is drained here, so a turn that throws after the flush
    // (provider error, abort, tool exception) would leave the message in memory
    // only, and a restart would lose the child result for good. One save for
    // the whole batch; the early return above keeps an empty queue from saving.
    this.save();
  }

  // Builds the system message injected into the parent's history once a child
  // finishes, capped at the configured budget. Single entry point: the message
  // wording lives here and nowhere else, and formatting has no side effect.
  protected formatSpawnResult(handle: SpawnHandle): string {
    const max = childResultBudget(this.config.config.sessions?.childResultMaxChars);
    const header = `[spawn ${handle.spawnId} · ${handle.agentId} · ${handle.status}]`;
// A cancelled child has no report to deliver: say so, and write no artifact
// for an outcome the user asked to stop. settle() always records the
// cancellation summary, so it is present here.
if (handle.status === "cancelled") return `${header} ${handle.summary ?? "cancelled"}`;

    const report =
      handle.status === "error"
        ? outcomeText(handle.error, "unknown error")
        : outcomeText(handle.result, "(no output)");

    // A report longer than the budget is not delivered as a silent cut: the
    // whole text goes to an artifact inside the workspace and the message
    // carries its absolute path, a one-line summary and how many characters
    // were kept, so the parent can read the rest instead of deciding on a
    // report it never saw. Under the budget the message keeps its original
    // shape, byte for byte, and writes nothing.
    if (report.length <= max) {
      return handle.status === "error" ? `${header} ${report}` : `${header}\n${report}`;
    }

    const body = `${report.slice(0, max)}…`;
    // The full length comes from the handle when the settlement recorded it, so the
    // notice and SpawnHandle.resultChars cannot drift apart.
    const total = handle.resultChars ?? report.length;
    const notice = `Ajustado a ${max} de ${total} caracteres.`;
    const summary = summarize(report);
    const path = this.ensureResultArtifact(handle);

    const lines = [header];
    if (summary) lines.push(`Resumen: ${summary}`);

    if (path) {
      lines.push(`Informe completo (${report.length} caracteres) en: ${path}`);
      lines.push(`${notice} Este mensaje es un recorte; el fichero es el informe íntegro.`);
      lines.push(ARTIFACT_INSTRUCTION);
    } else {
      // The artifact could not be written: degrade to the bounded message and
      // never announce a path that does not exist, which would cost the parent
      // a turn and invite it to invent the content.
      lines.push(notice);
    }

    lines.push("---", body);

    return lines.join("\n");
  }

  // Writes the whole report of a settled child to
  // <workspace>/.racso-harness/artifacts/<sessionId>/<spawnId>.md and returns its
  // absolute path, or undefined when it is not a path the parent could read.
  // The write replaces the file, so it is idempotent: a resumed delivery stores
  // the current report instead of appending to the previous one. Best effort by
  // design: it runs on the delivery path, never throws and never blocks the
  // message.
  //
  // The guarantee is about the BYTES, not only about the announced path: every
  // existing component of the target is resolved for real (symlinks expanded,
  // the missing tail only appended when its names are plain) and the write is
  // refused when the target lands outside the real workspace. A prefix
  // comparison against the unresolved root is not enough: with
  // <workspace>/.racso-harness a symlink pointing outside, the path still
  // starts with the root while mkdir + write would create the file on the
  // other side of the link.
  // The final component gets the same treatment: a link named <spawnId>.md
  // inside an honest directory would still redirect the bytes, so the write
  // uses "wx" and replaces the entry instead of writing through it.
  // What this does NOT do: check and write are separate syscalls, so a
  // component swapped for a symlink between them is only caught by the
  // post-write belt, which withholds the path instead of moving the bytes back.
  protected ensureResultArtifact(handle: SpawnHandle): string | undefined {
    const root = this.workspaceRoot();

    try {
      const report = handle.status === "error" ? handle.error : handle.result;
      // Unreachable from formatSpawnResult, which only calls this for a report over
      // the budget (a blank report falls back to a placeholder shorter than any
      // budget). Kept as a defensive type narrowing, silent on purpose: there is
      // nothing to warn about, the delivery is intact.
      if (!report || !report.trim()) return undefined;

      const path = spawnArtifactPath(root, this.sessionId, handle.spawnId);
      const dir = nodePath.dirname(path);
      if (!isInsideRealWorkspace(root, dir)) {
        logger.warn(
          `Dropped the report artifact of ${handle.spawnId}: ${dir} resolves outside the workspace`,
        );
        return undefined;
      }

      fs.mkdirSync(dir, { recursive: true });
      // The write must not follow a link at the final component: a symlink named
      // <spawnId>.md inside the jail would carry the report outside it while the
      // directory pre-check still reads as inside. "wx" refuses to write through
      // an existing entry, so the link is removed and the file created in place.
      try {
        fs.writeFileSync(path, report, { encoding: "utf8", flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        fs.unlinkSync(path);
        fs.writeFileSync(path, report, { encoding: "utf8", flag: "wx" });
      }

      // Belt on top of the pre-check: a component that appeared between the two
      // calls still must not be published as a path the parent cannot read.
      if (!isInsideRealWorkspace(root, path)) {
        logger.warn(
          `Dropped the path of the report artifact of ${handle.spawnId}: ${path} resolves outside the workspace`,
        );
        return undefined;
      }

      return path;
    } catch (err) {
      logger.warn(
        `Could not write the report artifact of ${handle.spawnId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  // Compacts the session history using the configured threshold and, when the
  // history actually changed, records what was folded into the memory.
  async compactSession() {
    if (!this.provider) throw new Error("Session not initialized");

    const before = this.history;
    const result = compactHistoryWithSummary(
      this.history,
      this.config.config.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD,
      this.provider.getContextWindow(),
    );
    this.history = result.history;
    const changed = this.history !== before;

    if (changed) {
      this.provider.resetContextUsage();
      this.save();
      await this.captureCompaction(result.summary, result.title);
    }
    return changed;
  }

  // Writes the folded window to the memory backend as an episode. Memory never
  // breaks compaction: a failing backend is a warning and the compacted history
  // is returned as usual.
  protected async captureCompaction(summary: string, title: string): Promise<void> {
    const memory = this.config.config.memory;
    if (memory?.enabled !== true) return;
    if (memory.captureOnCompact === false) return;
    if (!summary.trim()) return;

    try {
      await this.memoryProvider.capture({
        kind: "episode",
        scope: "project",
        title: redact(title || "Compacted session"),
        content: redact(summary),
        project: this.memoryProject(),
        sessionId: this.sessionId,
      });
    } catch (error) {
      logger.warn({ err: error }, "Memory capture on compact failed");
    }
  }

  // Classifies the prompt and dispatches it to text or image generation.
  async ask(prompt: string, onEvent?: ChatEventListener, options: AskTurnOptions = {}) {
    if (!this.provider) throw new Error("Session not initialized");
    // Already cancelled: do not spend a classification call nor touch history.
    if (options.signal?.aborted) throw options.signal.reason;

    // Deliver before the turn reads history, so the parent starts the turn
    // with the child results already in context instead of mid-conversation.
    this.flushPendingSpawns();

    const action = await this.classifyAction(prompt, options.signal);

    const response =
      action === "imageGeneration"
        ? await this.runImageTurn(prompt, options)
        : await this.runAgentLoop(prompt, onEvent, options);

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
    options: AskTurnOptions = {},
  ): Promise<AgentResponse> {
    const provider = this.provider;
    if (!provider) throw new Error("Session not initialized");

    const toolsConfig = this.config.config.tools;
    const configuredMax = Math.max(1, toolsConfig?.maxIterations ?? 8);
    const maxIterations = this.agent?.maxIterations
      ? Math.min(configuredMax, this.agent.maxIterations)
      : configuredMax;
    const specs = toolsConfig?.enabled === false ? [] : this.tools.specs();

    this.history.push(this.userMessage(prompt, options));

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
      // An abort is never retried: a cancelled turn must not spend another
      // request, whatever loop it is in.
      if (options.signal?.aborted) throw options.signal.reason;

      const result = await provider.chat(this.history, {
        tools: specs,
        onEvent,
        signal: options.signal,
      });

      this.addUsage(usage, result.usage);
      costUsd += result.costUsd ?? 0;
      lastText = result.turn.text;

      const toolCalls = result.turn.toolCalls ?? [];
      // An answer with neither text nor a tool call is the gateway coming back
      // empty (transient error, rate limit, truncated stream). It is not a
      // valid "finished" turn: treating it as one closed the turn with an empty
      // assistant message, the "turn failed" the user sees with nothing to
      // explain it. Retry a couple of times; if it stays empty, report a
      // failure instead of a silent success.
      const empty = !result.turn.text.trim() && toolCalls.length === 0;

      // A turn aborted right after an empty answer is not a flaky gateway:
      // the cancel is why it looked empty, so it must not be retried.
      if (empty && iteration < maxIterations - 1 && !options.signal?.aborted) {
        logger.warn("Empty assistant turn; retrying");
        continue;
      }

      // The empty answer is not persisted: an assistant message with no content
      // and no tool call only pollutes the history and confuses the UI.
      if (!empty) this.appendAssistant(result.turn.text, toolCalls);

      if (!empty) {
        // With no tool calls this is the final answer; with them, keep looping
        // and feed the results back.
        if (result.turn.finishReason !== "toolCalls" || toolCalls.length === 0) {
          return {
            text: result.turn.text,
            usage,
            costUsd,
            outcome: this.outcomeOf(failedTools),
          };
        }
      } else {
        return {
          text: "Stopped: the model returned an empty response",
          usage,
          costUsd,
          outcome: {
            status: "incomplete",
            pending: [...failedTools, "get a non-empty answer from the model"],
            next: "Retry the turn; if it persists, check the gateway quota and status.",
          },
        };
      }

      for (const call of toolCalls) {
        const toolResult = await this.runTool(call, onEvent, options.signal);
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

  protected async runTool(
    call: ToolCall,
    onEvent?: ChatEventListener,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    logger.info(`Tool call: ${call.name} ${this.preview(call.args)}`);

    const result = await this.tools.execute(this.toolContext(call, onEvent, signal), call);

    if (result.isError) {
      logger.warn(`Tool ${call.name} failed: ${this.preview(result.output)}`);
    }

    return result;
  }

  // The user turn as it enters the history. The flag travels with the message
  // so conversation() can hide it without losing the turn the model needs.
  protected userMessage(prompt: string, options: { unprompted?: true } = {}): History {
    const message: Extract<History, { role: "user" }> = { role: "user", content: prompt };
    if (options.unprompted) message.unprompted = true;

    return message;
  }

  // Image turns go straight to the image endpoint, with no agent loop and no
  // assistant message of their own: the images live in the response. The
  // prompt still belongs in the history, in the same shape the text path
  // pushes, so a resumed session shows the request next to its answer.
  protected async runImageTurn(
    prompt: string,
    options: { unprompted?: true } = {},
  ): Promise<AgentResponse> {
    const provider = this.provider;
    if (!provider) throw new Error("Session not initialized");

    this.history.push(this.userMessage(prompt, options));

    return provider.generateImage(prompt);
  }

  protected appendAssistant(text: string, toolCalls: ToolCall[]) {
    const message: Extract<History, { role: "assistant" }> = {
      role: "assistant",
      content: text,
    };
    if (toolCalls.length) message.toolCalls = toolCalls;

    this.history.push(message);
  }

  // One source of truth for the directory the tools resolve against and the one
  // announced in the system prompt: if they diverged, the model would believe it
  // works somewhere while every file operation happens elsewhere.
  protected workspaceRoot(): string {
    return workspaceRoot(this.config.config.tools?.workspace);
  }

  protected toolContext(
    call?: ToolCall,
    onEvent?: ChatEventListener,
    signal?: AbortSignal,
  ): ToolContext {
    return {
      cwd: this.workspaceRoot(),
      sessionId: this.sessionId,
      // Lets a long-running tool (shell and friends) kill its work when the
      // turn is cancelled, instead of owning a signal that never arrives.
      signal,
      approve: (request) => this.approve(request),
      spawn: (agentId, prompt) => this.spawn(agentId, prompt),
      getSkillBody: (id) => this.skillBody(id),
      listSkillIds: () => this.skillIds(),
      recallMemory: (query, limit) => this.recallMemory(query, limit),
      rememberMemory: (input) => this.rememberMemory(input),
      forgetMemory: (id, scope) => this.forgetMemory(id, scope),
      listMemories: (limit) => this.listMemories(limit),
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

  // Identity of the memory project: configured override, git remote, or a
  // hashed workspace path. Resolved once per workspace and cached.
  protected projectIdentityFor(): ProjectIdentity {
    const cwd = this.workspaceRoot();

    if (this.projectIdentity && this.projectIdentityCwd === cwd) return this.projectIdentity;

    this.projectIdentity = resolveProjectIdentity({
      configured: this.config.config.memory?.project,
      cwd,
    });
    this.projectIdentityCwd = cwd;

    return this.projectIdentity;
  }

  // Key that scopes project memories, so two workspaces never read each other's.
  protected memoryProject(): string {
    return this.projectIdentityFor().key;
  }

  // Where the project key came from ("config" | "git" | "path"), for diagnostics.
  protected memoryProjectSource(): ProjectIdentity["source"] {
    return this.projectIdentityFor().source;
  }

  // Searches the persistent memory on behalf of the recall tool. Never throws:
  // a down backend is an empty result, which the tool reports as "not found".
  protected async recallMemory(query: string, limit?: number): Promise<MemoryHit[]> {
    try {
      return await this.memoryProvider.search({
        text: query,
        limit,
        project: this.memoryProject(),
      });
    } catch (error) {
      logger.warn({ err: error }, "Memory search failed");

      return [];
    }
  }

  // Injects the memory context into the history, right after the persona. This
  // is the only place that writes the block: initialize() calls it on the
  // new-session branch and load() calls it once the history is restored, so a
  // resumed session never gets it twice. Stripping before injecting is what
  // makes the operation idempotent, including on a record that already carries
  // the block from a previous run.
  protected async injectMemoryContext(): Promise<void> {
    const memory = this.config.config.memory;
    if (memory?.enabled !== true) return;
    if (memory.injectOnStart === false) return;

    this.history = stripMemoryBlocks(this.history);

    try {
      const text = await this.memoryProvider.context({
        project: this.memoryProject(),
        maxChars: memory.maxContextChars ?? 2000,
      });
      if (!text.trim()) return;

      // The persona owns index 0; without one, the block goes first.
      if (this.history[0]?.role === "system") {
        this.history.splice(1, 0, composeMemoryBlock(text));
      } else {
        this.history.unshift(composeMemoryBlock(text));
      }
    } catch (error) {
      logger.warn({ err: error }, "Memory context injection failed");
    }
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

  // Health of the memory backend, so the CLI can warn when it is down. Also
  // reports the project key in use and where it came from.
  async memoryStatus(): Promise<{
    provider: string;
    ok: boolean;
    detail?: string;
    project?: string;
    projectSource?: string;
  }> {
    const health = await this.memoryProvider.health();
    const identity = this.projectIdentityFor();

    return {
      provider: this.memoryProvider.id,
      ok: health.ok,
      detail: health.detail,
      project: identity.key,
      projectSource: identity.source,
    };
  }

  // Writes one observation on behalf of the remember tool. Same contract as
  // captureCompaction - the persisted text is redacted first, and the project key
  // and the session id come from here, never from the model - but not the same
  // call site: compaction writes on its own, because it has no model input.
  protected async rememberMemory(input: RememberInput): Promise<RememberResult> {
    if (!this.memoryProvider.capabilities().capture) return { error: "unsupported" };

    try {
      const { id } = await this.memoryProvider.capture({
        kind: input.kind,
        scope: input.scope,
        // Redacted after trimming is not needed: the tool already trimmed, and
        // redacting keeps the text the user typed in every other respect.
        title: redact(input.title),
        content: redact(input.content),
        ...(input.topicKey ? { topicKey: input.topicKey } : {}),
        project: this.memoryProject(),
        sessionId: this.sessionId,
      });
      // The providers report a down backend as an empty id instead of throwing.
      if (!id) return { error: "failed" };

      return { id };
    } catch (error) {
      logger.warn({ err: error }, "Memory capture failed");

      return { error: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Deletes one observation on behalf of the forget tool. The scope check is
  // here because it is the only place that knows both the session id and the
  // project key; the approval gate runs after the lookup so a request for an id
  // that does not exist never reaches the user.
  //
  // `scope` is the caller's intent and defaults to the contract's "project". It
  // is not a permission: ownsObservation() compares against the stored scope, so
  // asking for a wider one never grants access to another session's memory.
  protected async forgetMemory(id: string, scope: MemoryScope = "project"): Promise<ForgetResult> {
    // Logged rather than acted on: it says what the caller believes it is
    // deleting, and the stored entry decides whether it may.
    logger.debug({ id, scope }, "Memory delete requested");
    if (!this.memoryProvider.capabilities().forget)
      return { forgotten: false, reason: "unsupported" };

    const provider = this.memoryProvider;
    const inspect = provider.inspect;
    // Without a lookup there is no way to tell whose memory this is, and deleting
    // blind would cross the boundary the scope check exists to enforce.
    if (!inspect) return { forgotten: false, reason: "unsupported" };

    try {
      const observation = await inspect.call(provider, id);
      if (!observation) return { forgotten: false, reason: "not-found" };
      if (!this.ownsObservation(observation)) {
        return { forgotten: false, reason: "out-of-scope" };
      }

      const decision = await this.approve({
        tool: "forget",
        kind: "write",
        subject: `memory:${id}`,
      });
      if (decision === "deny") return { forgotten: false, reason: "failed" };

      const forgotten = await this.memoryProvider.forget(id);
      return forgotten ? { forgotten: true, reason: "ok" } : { forgotten: false, reason: "failed" };
    } catch (error) {
      logger.warn({ err: error }, "Memory delete failed");

      return { forgotten: false, reason: "failed" };
    }
  }

  // A user-scoped memory belongs to everybody, a session one only to the session
  // that wrote it and a project one only to the workspace that wrote it. The
  // project key already hashes the path/config, so comparing it is enough. The
  // stored scope decides, not the caller's: asking for another one is not a way
  // in, so the caller's scope is only there to document intent.
  protected ownsObservation(observation: MemoryObservation): boolean {
    switch (observation.scope) {
      case "user":
        return true;
      case "session":
        return observation.sessionId === this.sessionId;
      case "project":
        return observation.project === this.memoryProject();
      default:
        return false;
    }
  }

  // Newest memories first, for the listMemories tool. No query involved, so it
  // prefers `recent` and falls back to an empty search, which is the only thing
  // a backend without it understands.
  protected async listMemories(limit?: number): Promise<MemoryHit[]> {
    try {
      const recent = this.memoryProvider.recent;
      if (recent) {
        return await recent.call(this.memoryProvider, { project: this.memoryProject(), limit });
      }

      return await this.memoryProvider.search({
        text: "",
        project: this.memoryProject(),
        limit,
      });
    } catch (error) {
      logger.warn({ err: error }, "Memory listing failed");

      return [];
    }
  }

  // Public memory delete used by the harness contract. A caller that does not
  // say the scope is acting on its own project, which is what every listing
  // shows by default.
  forgetStoredMemory(id: string, options: { scope?: MemoryScope } = {}): Promise<boolean> {
    return this.forgetMemory(id, options.scope ?? "project").then(
      (result) => result.reason === "ok",
    );
  }

  listStoredMemories(limit?: number): Promise<MemoryHit[]> {
    return this.listMemories(limit);
  }

  // Public memory search used by the harness contract.
  searchMemory(query: string, limit?: number): Promise<MemoryHit[]> {
    return this.recallMemory(query, limit);
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
  async classifyAction(prompt: string, signal?: AbortSignal) {
    if (!this.provider) throw new Error("Session not initialized");
    return classifyAction(prompt, this.classifierProvider ?? this.provider, signal);
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
        this.workspaceRoot(),
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
