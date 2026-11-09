export { createHarness } from "./harness";
export {
  createLogger,
  DEFAULT_LOG_LEVEL,
  getLoggerLevel,
  logger,
  setLogger,
  setLoggerLevel,
} from "./utils/logger";
export type { LoggerOptions, LogLevel } from "./utils/logger";
export { Config, DEFAULT_PROVIDER_TYPE, SUPPORTED_PROVIDERS } from "./configuration";
export type {
  MemoryConfig,
  McpConfig,
  ProviderConfig,
  ProviderDetail,
  SessionsConfig,
  SkillsConfig,
} from "./configuration";
export { SessionStore } from "./session/SessionStore";
export { SessionManager } from "./session/SessionManager";
export {
  createMemoryProvider,
  HttpMemoryProvider,
  LocalMemoryProvider,
  NoopMemoryProvider,
} from "./memory";

export type {
  ApprovalHandler,
  HarnessDeps,
  HarnessOptions,
  IHarness,
  ILogger,
  LoggerSink,
  SpawnEvent,
  SpawnEventListener,
  SpawnOptions,
} from "./contract";
export type { AgentApproval, AgentDefinition, AgentSummary } from "./agents";
export type { SessionRecord } from "./session/SessionStore";
export type { Skill, SkillSummary } from "./skills/Skill";
export type {
  McpServerConfig,
  McpServerSummary,
  McpToolSummary,
  McpTransportName,
  ResolvedMcpServer,
} from "./mcp";
export { isMcpToolName, mcpToolName, parseMcpToolName, resolveMcpServers } from "./mcp";
// MemoryKind and MemoryScope ride along because MemoryHit references them:
// without them the emitted .d.ts is unusable for consumers.
export type {
  MemoryCapabilities,
  MemoryContextOptions,
  MemoryHit,
  MemoryKind,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
  MemoryScope,
} from "./memory";
export type { SpawnHandle, SpawnStatus } from "./contract";
export type { ApprovalDecision, ApprovalRequest } from "./tools";
export type {
  AgentResponse,
  ChatEvent,
  ChatEventListener,
  TurnOutcome,
  History,
  Model,
  Provider,
  TokenUsage,
} from "./types/providers";
export type {
  ConversationEntry,
  SessionStatus,
  SessionSummary,
  SessionUsage,
} from "./types/session";
export type { UiConfig, UiRoleStyle, UiTheme } from "./configuration";
