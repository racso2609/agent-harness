export { createHarness } from "./harness";
export { createLogger, logger, setLogger } from "./utils/logger";
export { Config, SUPPORTED_PROVIDERS } from "./configuration";
export { SessionStore } from "./session/SessionStore";
export { SessionManager } from "./session/SessionManager";

export type {
  ApprovalHandler,
  HarnessDeps,
  HarnessOptions,
  IHarness,
  ILogger,
  LoggerSink,
  SpawnOptions,
} from "./contract";
export type {
  AgentApproval,
  AgentDefinition,
  AgentSummary,
} from "./agents";
export type { SessionRecord } from "./session/SessionStore";
export type { SpawnHandle, SpawnStatus } from "./session/spawn";
export type { ApprovalDecision, ApprovalRequest } from "./tools";
export type {
  AgentResponse,
  History,
  Model,
  Provider,
  TokenUsage,
} from "./types/providers";
export type {
  SessionStatus,
  SessionSummary,
  SessionUsage,
} from "./types/session";
