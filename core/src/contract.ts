import type { AgentSummary } from "@/agents";
import type { MemoryHit } from "@/memory";
import type { SkillSummary } from "@/skills";
import type { Config, ProviderConfig, ProviderDetail } from "@/configuration";
import type { McpServerSummary, McpToolSummary } from "@/mcp";
import type { SpawnEvent, SpawnEventListener, SpawnHandle, SpawnStatus } from "@/session/spawn";
import type { SessionStore } from "@/session/SessionStore";
import type { ApprovalDecision, ApprovalRequest } from "@/tools";
import type { ChatEventListener, AgentResponse, Model } from "@/types/providers";
import type { ConversationEntry, SessionStatus, SessionSummary } from "@/types/session";

// Structured logger handed to the harness. Compatible with pino call shapes:
// both logger.info("message") and logger.info({ meta }, "message") work.
export interface ILogger {
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
}

// Receives one already-formatted log line. The sink knows nothing about
// prompts, menus or cursor state; that belongs to the CLI renderer.
export type LoggerSink = (line: string) => void;

// Resolves a side-effect permission request. Core remembers the "always"
// answer, so the handler only has to report the raw decision.
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface HarnessDeps {
  // Logger for the whole harness. Defaults to a stderr sink.
  logger?: ILogger;
  // Handler used when the approval policy is "ask". Without one, core denies.
  approval?: ApprovalHandler;
  // Prebuilt config, so the CLI can run setup before booting the harness.
  config?: Config;
  // Session persistence layer; defaults to the home-directory store.
  store?: SessionStore;
}

export interface HarnessOptions {
  // Resumes a previously persisted session.
  sessionId?: string;
  // Agent used when starting a new session.
  agent?: string;
}

export interface AskOptions {
  // Receives progress as the turn is produced (text, reasoning, tool calls).
  // Optional: omitting it keeps the existing blocking behaviour.
  onEvent?: ChatEventListener;
  // The prompt was not written by the user: the session started the turn on
  // its own (an automatic continuation after a child settled). It is kept in
  // the history — the model must see it as a turn — but conversation() leaves
  // it out, because nobody typed it.
  unprompted?: true;
}

export interface SpawnOptions {
  // Extra context prepended to the child's prompt.
  context?: string;
}

// Non-interactive public surface of the harness. No terminal concerns.
export interface IHarness {
  // Validates config, creates the provider and loads agent/session.
  initialize(options?: HarnessOptions): Promise<void>;

  // Runs one turn. Images are domain data; the caller decides how to render.
  ask(prompt: string, options?: AskOptions): Promise<AgentResponse>;

  // Snapshot of usage, cost, context and active agent/provider.
  status(): SessionStatus;

  // --- sessions ---
  listSessions(): SessionSummary[];
  // Resolves a full id, unique prefix or 1-based list index.
  resolveSession(target: string): string | undefined;
  // Persists the current session and loads the resolved one.
  loadSession(target: string): Promise<boolean>;
  save(): void;
  // The conversation as the UI reads it back, oldest first. Only user and
  // assistant messages: system, tool output and empty turns are filtered out.
  conversation(): ConversationEntry[];

  // --- providers / models ---
  listProviders(): string[];
  listProviderDetails(): ProviderDetail[];
  // Creates or replaces a provider instance (id libre + type de backend).
  configureProvider(
    id: string,
    provider: ProviderConfig,
    options?: { makeDefault?: boolean; model?: string },
  ): void;
  // Removes a provider instance. false when it does not exist.
  removeProvider(id: string): boolean;
  setProvider(name: string): Promise<boolean>;
  listModels(): Model[];
  setModel(model: string): boolean;

  // --- agents ---
  listAgents(): AgentSummary[];

  // --- skills ---
  // Skills available to the active session, index only (no bodies).
  listSkills(): SkillSummary[];
  // Re-scans the skills directories and refreshes the system prompt.
  reloadSkills(): SkillSummary[];
  setAgent(agentId: string): Promise<boolean>;

  // --- memory ---
  // Health of the configured memory backend, for diagnostics.
  memoryStatus(): Promise<{ provider: string; ok: boolean; detail?: string }>;
  // Searches the persistent memory. Empty when memory is off or down.
  searchMemory(query: string, limit?: number): Promise<MemoryHit[]>;

  // --- mcp ---
  // One entry per configured MCP server (id, transport, connection status,
  // number of tools discovered, and the error when it failed). Reading it never
  // starts a server: `idle` is the state of one that was never connected.
  listMcpServers(): McpServerSummary[];
  // Closes every MCP connection, forgets them and discovers again, returning
  // the servers as they are afterwards. The only way back from a server that
  // failed, since the manager never retries on its own. It does NOT re-read
  // config.json: the servers are the ones the config held at boot.
  reloadMcp(): Promise<McpServerSummary[]>;
  // Every MCP tool discovered so far, as a listing shows it: the composite
  // name the model sees, the server it comes from and its description.
  mcpTools(): McpToolSummary[];

  // --- approvals ---
  approveWith(handler: ApprovalHandler): void;

  // --- background children ---
  spawn(agentId: string, prompt: string, options?: SpawnOptions): SpawnHandle;
  pollSpawn(spawnId: string): SpawnHandle | undefined;
  // Live children of the current process only.
  listSpawns(): SpawnHandle[];
  // Every child this session ever launched, including the ones restored from a
  // previous run. Read-only: a restored child is never reattached.
  childHistory(): SpawnHandle[];
  // Settled children whose result has not entered a parent turn yet, in
  // settlement order. Empty when nothing is left to deliver. A read-only
  // view: reading it never drains it, delivery happens on the next parent turn.
  pendingSpawns(): SpawnHandle[];
  // Live-only subscription to children starting/finishing. Returns unsubscribe.
  onSpawnEvent(listener: SpawnEventListener): () => void;
  waitSpawn(spawnId: string): Promise<SpawnHandle | undefined>;
  collectSpawns(spawnIds?: string[]): Promise<SpawnHandle[]>;

  // --- maintenance ---
  compactSession(): Promise<boolean>;
  // Persists, then closes every MCP connection, without exiting: the CLI owns
  // process.exit.
  //
  // Returns a promise because the connection close is asynchronous, and the
  // spawned MCP servers must be dead before the process leaves (calling
  // process.exit first would orphan them). A caller that does not await it
  // still compiles; the CLI does await it, so the exit happens after the
  // children are gone.
  shutdown(): Promise<void>;
  // Closes every MCP connection and resolves once the spawned servers are dead,
  // without persisting: the CLI keeps the save and the close on separate
  // deadlines, because only the close can hang. Idempotent.
  closeMcp(): Promise<void>;
}

export type {
  ApprovalDecision,
  ApprovalRequest,
  ProviderConfig,
  ProviderDetail,
  SpawnEvent,
  SpawnEventListener,
  SpawnHandle,
  SpawnStatus,
};
