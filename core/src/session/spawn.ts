import type { AgentResponse } from "@/types/providers";

// Lifecycle of a background child agent. "cancelled" is terminal and is never
// delivered to the parent turn: the user gave up on that work.
export type SpawnStatus = "running" | "done" | "error" | "cancelled";

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
  // One-line summary of what the child did, derived at settlement from the
  // result (success) or the error message (failure). Undefined when the child
  // produced nothing summarisable.
  summary?: string;
  // Wall-clock duration in milliseconds, derived from startedAt/finishedAt at
  // settlement so readers never have to subtract the two ISO strings.
  durationMs?: number;
  // When the user asked for this child to stop (ISO string), set even when the
  // request arrived too late to change the outcome, so a handle cancelled after
  // it had already finished still records that the user gave up on it.
  // Written once at the first request and never cleared: it is part of the
  // persisted history, so a resumed session reads it back unchanged. Reading it
  // never changes a status (poll/list/childHistory just hand the handle over),
  // and it is absent on every child nobody ever cancelled.
  cancelRequestedAt?: string;
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
  // Set by settle(). The job is terminal from here on, even if the code that
  // settled it has not returned yet, so a late cancel cannot rewrite it.
  terminal: boolean;
}

export const DEFAULT_MAX_CHILDREN = 4;

// Budget of the one-line summary kept on a settled handle.
const SUMMARY_MAX_CHARS = 120;

// Summary carried by a cancelled handle. It is a fixed literal on purpose:
// the cancellation is not the child's output, so summarize() never derives it.
export const CANCELLED_SUMMARY = "cancelled by the user";

// Internal abort reasons. They are the only way the settlement point can tell
// why a child was aborted, which is what decides its final status. Not
// exported: callers read the resulting status off the handle.
class SpawnCancelledError extends Error {
  constructor() {
    super("Spawn cancelled by the user");
    this.name = "SpawnCancelledError";
  }
}

class SpawnTimeoutError extends Error {
  constructor() {
    super("Spawn timed out");
    this.name = "SpawnTimeoutError";
  }
}

// Builds the summary from the child's own output: no extra model call is
// made, the child's answer (or its error) is already the shortest faithful
// description of what happened. Whitespace is flattened so the value is
// always a single line, and empty text yields undefined rather than "".
const summarize = (text?: string): string | undefined => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();

  if (!flat) return undefined;

  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…` : flat;
};

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
      terminal: false,
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

  // Aborts a running child with the cancellation reason and reports whether the
  // abort was delivered. Returns false, without throwing, for an unknown id, for
  // a child that already settled and for one that is already aborting: this
  // signals, it does not settle, so the status flips to "cancelled" when the
  // job reaches its settlement point.
  cancel(spawnId: string): boolean {
    const job = this.jobs.get(spawnId);
    if (!job) return false;

    // Stamped before the guards below: a request that arrives after the job
    // settled still happened, and the handle must say so even though it cannot
    // change the outcome. The first request wins; a repeated one keeps it.
    if (!job.cancelRequestedAt) job.cancelRequestedAt = new Date().toISOString();

    if (job.terminal || job.controller.signal.aborted) return false;

    job.controller.abort(new SpawnCancelledError());
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
    let outcome: "done" | "error" = "done";

    try {
      const response = await this.runner({
        spawnId: job.spawnId,
        sessionId: job.sessionId,
        agentId: job.agentId,
        prompt: job.prompt,
        context,
        signal: job.controller.signal,
      });
      job.result = response.text;
    } catch (err) {
      outcome = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
      // Cancel and timeout race on the same controller, so the signal reason —
      // not the caught error — is what tells them apart: a cancelled child is
      // never reported as failed, and the first reason wins because abort() keeps
      // only the first one.
      const reason = job.controller.signal.reason;
      const status =
        reason instanceof SpawnCancelledError
          ? "cancelled"
          : reason instanceof SpawnTimeoutError || outcome === "error"
            ? "error"
            : "done";
      this.settle(job, status);
      this.emit({ type: "settled", handle: this.snapshot(job) });
    }
  }

  // Single settlement point. Success, error, timeout and cancel all end up in
  // the finally above, so this is the only place where status, finishedAt, the
  // error and the derived summary/durationMs are written.
  protected settle(job: SpawnJob, status: Exclude<SpawnStatus, "running">) {
    job.terminal = true;
    job.status = status;
    // A cancellation is not the child's failure, so it carries no error: the
    // child's own error here can only be the aborted request talking.
    job.error = status === "cancelled" ? undefined : job.error;
    job.finishedAt = new Date().toISOString();

    const elapsed = Date.parse(job.finishedAt) - Date.parse(job.startedAt);

    // A backwards clock jump must not leak a negative duration to consumers.
    job.durationMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined;
    // A cancellation is not the child's output, so it never goes through
    // summarize(): the fixed literal is the summary, whatever the error says.
    job.summary = status === "cancelled" ? CANCELLED_SUMMARY : summarize(job.result ?? job.error);
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
    // A child aborted while it waited for a slot reaches run() already aborted:
    // it must not get a budget for work it will never do, and the timeout would
    // otherwise claim an outcome that the cancellation already decided.
    if (this.timeoutMs <= 0 || job.terminal || job.controller.signal.aborted) return undefined;

    return setTimeout(() => {
      job.controller.abort(new SpawnTimeoutError());
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
      summary: job.summary,
      durationMs: job.durationMs,
      cancelRequestedAt: job.cancelRequestedAt,
    };
  }
}

export { SpawnManager };
