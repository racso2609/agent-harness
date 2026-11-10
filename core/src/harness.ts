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
import type { MemoryScope } from "@/memory";
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

  forgetMemory(id: string, options: { scope?: MemoryScope } = {}) {
    return this.session.forgetStoredMemory(id, options);
  }

  listMemories(limit?: number) {
    return this.session.listStoredMemories(limit);
  }

  listMcpServers() {
    return this.session.listMcpServers();
  }

  reloadMcp() {
    return this.session.reloadMcp();
  }

  mcpTools() {
    return this.session.mcpTools();
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

  // Closes every MCP connection, without persisting: the CLI keeps the save
  // and the close on separate deadlines. Idempotent, as `McpManager.close()` is.
  closeMcp(): Promise<void> {
    return this.session.closeMcp();
  }

  compactSession() {
    return this.session.compactSession();
  }

  // Persists the session, then closes every MCP connection and the memory
  // backend; the process lifecycle stays with the CLI, which awaits this
  // before process.exit.
  //
  // The close is awaited instead of fired and forgotten because an MCP server
  // is a child process: exiting first would leave it running (re-parented to
  // init), and nothing afterwards could reap it.
  //
  // A save that throws does not skip the close: the servers are children of
  // this process, so leaving them alive because the conversation could not be
  // written would orphan them for good. The save error still reaches the
  // caller, which decides how to report it.
  //
  // The two halves are caught apart, and the error is rethrown once the close
  // is done: a `finally` awaits the close with the save error still in flight,
  // and when that await rejects too, JS drops the original exception. Catching
  // each one keeps both; the save is the one reported, because it is the
  // failure of the session the user was working on, while a close that fails
  // has already signalled its servers.
  async shutdown(): Promise<void> {
    let saveError: unknown;
    try {
      this.session.save();
    } catch (error) {
      saveError = error;
    }

    let closeError: unknown;
    try {
      await this.session.closeMcp();
    } catch (error) {
      closeError = error;
    }

    // Memory holds a database handle and an HTTP pool: both are released here,
    // after the MCP servers, and a failure to release them does not stop the
    // other two halves from running. It is the last of the three reported: a
    // leaked handle costs less than a lost session or an orphaned server.
    let memoryError: unknown;
    try {
      await this.session.closeMemory();
    } catch (error) {
      memoryError = error;
    }

    const failure = saveError ?? closeError ?? memoryError;
    if (failure !== undefined) throw failure;
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
