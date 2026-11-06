export type MemoryScope = "user" | "project" | "session";

// `procedure` is deliberately left out: that is what skills are
// (core/src/skills/Skill.ts).
export type MemoryKind = "fact" | "decision" | "episode" | "preference";

export interface MemoryQuery {
  text: string;
  scope?: MemoryScope;
  project?: string;
  sessionId?: string;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface MemoryHit {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  // Already trimmed by the provider to `memory.maxHitChars`: the caller never
  // truncates again nor assumes it fits.
  content: string;
  score?: number;
  createdAt?: string;
  project?: string;
}

export interface MemoryObservation {
  kind: MemoryKind;
  scope: MemoryScope;
  title: string;
  content: string;
  project?: string;
  sessionId?: string;
  // Upsert key for facts that evolve ("how the login is fixed"): the backend
  // replaces the previous revision instead of piling up duplicates.
  topicKey?: string;
  metadata?: Record<string, string>;
}

export interface MemoryContextOptions {
  project?: string;
  sessionId?: string;
  scope?: MemoryScope;
  // Hard cap on the returned block, in characters. The provider MUST honour it.
  maxChars: number;
}

export interface MemoryCapabilities {
  search: boolean;
  context: boolean;
  capture: boolean;
  forget: boolean;
  // false on purely lexical backends (FTS5). The harness uses it to warn the
  // user that a semantic search will not work, not to change the flow.
  semantic: boolean;
  scopes: MemoryScope[];
}

export interface MemoryProvider {
  // Stable identifier for logs and for `memory.provider` in config.
  readonly id: string;
  capabilities(): MemoryCapabilities;
  // Never throws: a down backend is `{ ok: false }`, not an exception.
  health(): Promise<{ ok: boolean; detail?: string }>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
  context(options: MemoryContextOptions): Promise<string>;
  capture(observation: MemoryObservation): Promise<{ id: string }>;
  forget(id: string): Promise<boolean>;
  close(): Promise<void>;
}
