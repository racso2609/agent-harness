import type { AgentResponse } from "@/types/providers";

// Lifecycle of a background child agent.
export type SpawnStatus = "running" | "done" | "error";

// Snapshot of a child job, safe to hand to the UI or serialize.
export interface SpawnHandle {
  // Stable id returned to the parent when the child is launched.
  spawnId: string;
  // Session id of the persisted child session.
  sessionId: string;
  // Agent the child runs.
  agentId: string;
  // Original prompt handed to the child.
  prompt: string;
  status: SpawnStatus;
  // Creation timestamp (ISO string).
  startedAt: string;
  // Completion timestamp (ISO string), set once settled.
  finishedAt?: string;
  // Result text once the child succeeds.
  result?: string;
  // Error message once the child fails.
  error?: string;
}

// Runs one child to completion. Injected so the manager stays decoupled from
// SessionManager and easy to test.
export type SpawnRunner = (options: {
  spawnId: string;
  sessionId: string;
  agentId: string;
  prompt: string;
  context?: string;
  signal: AbortSignal;
}) => Promise<AgentResponse>;

export interface SpawnManagerOptions {
  runner: SpawnRunner;
  // Maximum number of concurrently running children.
  maxChildren?: number;
  // Wall-clock budget per child before it is aborted.
  timeoutMs?: number;
  // Session id provider; defaults to crypto.randomUUID.
  idFactory?: () => string;
}

// Lifecycle notification emitted as a child progresses. Pull helpers
// (poll/wait/collect) still work; events are pushed for reactive consumers.
export type SpawnEvent =
  { type: "started"; handle: SpawnHandle } | { type: "settled"; handle: SpawnHandle };

export type SpawnEventListener = (event: SpawnEvent) => void;

interface SpawnJob extends SpawnHandle {
  controller: AbortController;
  promise: Promise<void>;
}

export const DEFAULT_MAX_CHILDREN = 4;

// Tracks background child agents spawned by a parent session. Children run
// concurrently up to `maxChildren`; extra submissions wait in FIFO order.
class SpawnManager {
  protected jobs = new Map<string, SpawnJob>();
  protected queue: Array<() => void> = [];
  protected running = 0;
  protected runner: SpawnRunner;
  protected maxChildren: number;
  protected timeoutMs: number;
  protected idFactory: () => string;
  // Reactive subscribers notified on started/settled transitions.
  protected listeners = new Set<SpawnEventListener>();

  constructor(options: SpawnManagerOptions) {
    this.runner = options.runner;
    this.maxChildren = Math.max(1, options.maxChildren ?? DEFAULT_MAX_CHILDREN);
    this.timeoutMs = options.timeoutMs ?? 0;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  // Subscribes to spawn lifecycle events. Returns an unsubscribe function.
  on(listener: SpawnEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Launches a child. Returns immediately with a handle; the run happens in
  // the background, bounded by the concurrency limit.
  spawn(input: {
    agentId: string;
    sessionId: string;
    prompt: string;
    context?: string;
  }): SpawnHandle {
    const spawnId = `spawn-${this.idFactory()}`;
    const job: SpawnJob = {
      spawnId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      prompt: input.prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.jobs.set(spawnId, job);

    job.promise = this.enqueue(() => this.run(job, input.context));
    this.emit({ type: "started", handle: this.snapshot(job) });
    return this.snapshot(job);
  }

  // Returns a handle for a single child, or undefined when unknown.
  poll(spawnId: string): SpawnHandle | undefined {
    const job = this.jobs.get(spawnId);
    return job ? this.snapshot(job) : undefined;
  }

  // Lists every child of this manager, newest first.
  list(): SpawnHandle[] {
    return [...this.jobs.values()]
      .map((job) => this.snapshot(job))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // Waits for a child to settle and resolves with its handle.
  async wait(spawnId: string): Promise<SpawnHandle | undefined> {
    const job = this.jobs.get(spawnId);
    if (!job) return undefined;

    await job.promise;
    return this.snapshot(job);
  }

  // Waits for every child of the given ids (default: all) and returns their
  // final handles.
  async collect(spawnIds?: string[]): Promise<SpawnHandle[]> {
    const ids = spawnIds ?? [...this.jobs.keys()];
    const jobs = ids.map((id) => this.jobs.get(id)).filter((job): job is SpawnJob => Boolean(job));

    await Promise.all(jobs.map((job) => job.promise));
    return jobs.map((job) => this.snapshot(job));
  }

  // Aborts a running child; no-op when already settled.
  cancel(spawnId: string): boolean {
    const job = this.jobs.get(spawnId);
    if (!job || job.status !== "running") return false;
    job.controller.abort();
    return true;
  }

  // Runs a job once a concurrency slot is available.
  protected enqueue(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = () => {
        this.running += 1;
        task().finally(() => {
          this.running -= 1;
          this.queue.shift()?.();
          resolve();
        });
      };

      if (this.running < this.maxChildren) start();
      else this.queue.push(start);
    });
  }

  // Executes the child, capturing result/error and applying the timeout.
  protected async run(job: SpawnJob, context?: string) {
    const timer = this.startTimeout(job);

    try {
      const response = await this.runner({
        spawnId: job.spawnId,
        sessionId: job.sessionId,
        agentId: job.agentId,
        prompt: job.prompt,
        context,
        signal: job.controller.signal,
      });
      job.status = "done";
      job.result = response.text;
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
      job.finishedAt = new Date().toISOString();
      this.emit({ type: "settled", handle: this.snapshot(job) });
    }
  }

  // Notifies subscribers; listener errors never break the scheduler.
  protected emit(event: SpawnEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer must not abort the child lifecycle.
      }
    }
  }

  protected startTimeout(job: SpawnJob) {
    if (this.timeoutMs <= 0 || job.controller.signal.aborted) return undefined;

    return setTimeout(() => {
      job.controller.abort(new Error("Spawn timed out"));
    }, this.timeoutMs);
  }

  protected snapshot(job: SpawnJob): SpawnHandle {
    return {
      spawnId: job.spawnId,
      sessionId: job.sessionId,
      agentId: job.agentId,
      prompt: job.prompt,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: job.result,
      error: job.error,
    };
  }
}

export { SpawnManager };
