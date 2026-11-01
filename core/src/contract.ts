import type { AgentSummary } from "@/agents";
import type { SkillSummary } from "@/skills";
import type { Config, ProviderConfig, ProviderDetail } from "@/configuration";
import type { SpawnHandle } from "@/session/spawn";
import type { SessionStore } from "@/session/SessionStore";
import type { ApprovalDecision, ApprovalRequest } from "@/tools";
import type { AgentResponse, Model } from "@/types/providers";
import type { SessionStatus, SessionSummary } from "@/types/session";

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
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

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

export interface SpawnOptions {
  // Extra context prepended to the child's prompt.
  context?: string;
}

// Non-interactive public surface of the harness. No terminal concerns.
export interface IHarness {
  // Validates config, creates the provider and loads agent/session.
  initialize(options?: HarnessOptions): Promise<void>;

  // Runs one turn. Images are domain data; the caller decides how to render.
  ask(prompt: string): Promise<AgentResponse>;

  // Snapshot of usage, cost, context and active agent/provider.
  status(): SessionStatus;

  // --- sessions ---
  listSessions(): SessionSummary[];
  // Resolves a full id, unique prefix or 1-based list index.
  resolveSession(target: string): string | undefined;
  // Persists the current session and loads the resolved one.
  loadSession(target: string): Promise<boolean>;
  save(): void;

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

  // --- approvals ---
  approveWith(handler: ApprovalHandler): void;

  // --- background children ---
  spawn(agentId: string, prompt: string, options?: SpawnOptions): SpawnHandle;
  pollSpawn(spawnId: string): SpawnHandle | undefined;
  listSpawns(): SpawnHandle[];
  waitSpawn(spawnId: string): Promise<SpawnHandle | undefined>;
  collectSpawns(spawnIds?: string[]): Promise<SpawnHandle[]>;

  // --- maintenance ---
  compactSession(): Promise<boolean>;
  // Persists without exiting; the CLI owns process.exit.
  shutdown(): void;
}

export type {
  ApprovalDecision,
  ApprovalRequest,
  ProviderConfig,
  ProviderDetail,
};
