import type {
  ApprovalHandler,
  HarnessDeps,
  HarnessOptions,
  AskOptions,
  IHarness,
  SpawnOptions,
} from "@/contract";
import { Config } from "@/configuration";
import { SessionManager } from "@/session/SessionManager";
import { SessionStore } from "@/session/SessionStore";
import type { SpawnEventListener, SpawnHandle } from "@/session/spawn";
import type { ApprovalRequest } from "@/tools";
import type { AgentResponse } from "@/types/providers";
import { createLogger, setLogger } from "@/utils/logger";

class Harness implements IHarness {
  constructor(protected session: SessionManager) {}

  initialize(options: HarnessOptions = {}) {
    return this.session.initialize(options);
  }

  ask(prompt: string, options: AskOptions = {}): Promise<AgentResponse> {
    return this.session.ask(prompt, options.onEvent, { unprompted: options.unprompted });
  }

  status() {
    return this.session.status();
  }

  listSessions() {
    return this.session.listSessions();
  }

  resolveSession(target: string) {
    return this.session.resolveSession(target);
  }

  // Persists the current session and resumes the resolved target.
  async loadSession(target: string) {
    const id = this.session.resolveSession(target);
    if (!id) return false;
    if (id === this.session.sessionId) return true;

    this.session.save();
    const loaded = await this.session.load(id);
    if (loaded) this.session.save();
    return loaded;
  }

  save() {
    this.session.save();
  }

  conversation() {
    return this.session.conversation();
  }

  listProviders() {
    return this.session.listProviders();
  }

  listProviderDetails() {
    return this.session.listProviderDetails();
  }

  configureProvider(
    id: string,
    provider: { type?: string; url: string; apikey: string; model?: string },
    options: { makeDefault?: boolean } = {},
  ) {
    this.session.configureProvider(id, provider, options);
  }

  removeProvider(id: string) {
    return this.session.removeProvider(id);
  }

  setProvider(name: string) {
    return this.session.setProvider(name);
  }

  listModels() {
    return this.session.provider?.listModels?.() ?? [];
  }

  setModel(model: string) {
    return this.session.setModel(model);
  }

  listAgents() {
    return this.session.listAgents();
  }

  listSkills() {
    return this.session.listSkills();
  }

  reloadSkills() {
    return this.session.reloadSkills();
  }

  setAgent(agentId: string) {
    return this.session.setAgent(agentId);
  }

  memoryStatus() {
    return this.session.memoryStatus();
  }

  searchMemory(query: string, limit?: number) {
    return this.session.searchMemory(query, limit);
  }

  approveWith(handler: ApprovalHandler) {
    this.session.approveWith(handler);
  }

  spawn(agentId: string, prompt: string, options: SpawnOptions = {}) {
    return this.session.spawn(agentId, prompt, options);
  }

  pollSpawn(spawnId: string): SpawnHandle | undefined {
    return this.session.pollSpawn(spawnId);
  }

  onSpawnEvent(listener: SpawnEventListener): () => void {
    return this.session.onSpawnEvent(listener);
  }

  listSpawns(): SpawnHandle[] {
    return this.session.listSpawns();
  }

  childHistory(): SpawnHandle[] {
    return this.session.childHistory();
  }

  pendingSpawns(): SpawnHandle[] {
    return this.session.pendingSpawns();
  }

  waitSpawn(spawnId: string) {
    return this.session.waitSpawn(spawnId);
  }

  collectSpawns(spawnIds?: string[]) {
    return this.session.collectSpawns(spawnIds);
  }

  compactSession() {
    return this.session.compactSession();
  }

  // Persists the session; process lifecycle belongs to the CLI.
  shutdown() {
    this.session.save();
  }
}

export const createHarness = (deps: HarnessDeps = {}): IHarness => {
  const logger = deps.logger ?? createLogger();
  setLogger(logger);

  const config = deps.config ?? new Config();
  const store = deps.store ?? new SessionStore();
  const session = new SessionManager(config, store);

  if (deps.approval) session.approveWith(deps.approval);

  return new Harness(session);
};

export type { ApprovalRequest };
