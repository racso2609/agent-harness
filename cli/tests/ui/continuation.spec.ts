import { describe, expect, it } from "vitest";
import type { SpawnHandle } from "@racso/core";
import {
  batchKey,
  CONTINUATION_DROPPED_NOTICE,
  CONTINUATION_PROMPT,
  continuationDecision,
  DRAFT_WAITING_NOTICE,
  dropContinuations,
  hasPendingWork,
  type QueuedPrompt,
} from "../../src/ui/continuation";

const handle = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
  spawnId: "spawn-1",
  sessionId: "session-1",
  agentId: "coder",
  prompt: "implement",
  status: "done",
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(1_000).toISOString(),
  result: "half of the migration is applied",
  ...overrides,
});

const waiting = (pending: SpawnHandle[], hasUserDraft = false) =>
  continuationDecision({ waitingForPrompt: true, hasUserDraft, pending });

describe("continuation", () => {
  it("continues when an undelivered child left a result", () => {
    expect(waiting([handle()])).toEqual({ continue: true, notice: null });
  });

  it("does not continue for a child that failed", () => {
    // A failed child hands nothing over; the user decides what to do with it.
    const failed = [handle({ status: "error", result: undefined, error: "provider down" })];

    expect(hasPendingWork(failed)).toBe(false);
    expect(waiting(failed)).toEqual({ continue: false, notice: null });
  });

  it("does not continue for a successful child with an empty result", () => {
    expect(waiting([handle({ result: "   " })])).toEqual({ continue: false, notice: null });
  });

  it("does not continue with nothing undelivered", () => {
    // A settle that just arrived must not fire once another path already
    // delivered it: the empty list is the answer.
    expect(waiting([])).toEqual({ continue: false, notice: null });
  });

  it("keeps waiting while the loop is inside a turn", () => {
    // The child settled mid-turn: the end of that turn judges it, not the
    // settle itself, or two turns would race for the same history.
    expect(
      continuationDecision({ waitingForPrompt: false, hasUserDraft: false, pending: [handle()] }),
    ).toEqual({ continue: false, notice: null });
  });

  it("waits and says so when the user is typing", () => {
    expect(waiting([handle()], true)).toEqual({
      continue: false,
      notice: DRAFT_WAITING_NOTICE,
    });
  });

  it("announces the same text for a batch of several children", () => {
    const batch = [handle({ spawnId: "a" }), handle({ spawnId: "b", status: "error" })];

    expect(waiting(batch, true)).toEqual({ continue: false, notice: DRAFT_WAITING_NOTICE });
  });

  it("starts one single turn for every undelivered child", () => {
    // The decision speaks for the whole batch: there is no per-child verdict
    // that could turn one settle into three turns.
    const batch = [handle({ spawnId: "a" }), handle({ spawnId: "b" })];

    expect(waiting(batch)).toEqual({ continue: true, notice: null });
  });

  it("keeps the continuation prompt in English and self-terminating", () => {
    expect(CONTINUATION_PROMPT).toBe(
      "Continue with the work left by the children whose results you just received. If nothing is left, say so and stop.",
    );
  });

  it("gives each undelivered batch a key that changes with its members", () => {
    // The key is what makes the waiting notice once-per-batch: same members in
    // another order are the same batch, a new or delivered child is not.
    const a = handle({ spawnId: "a" });
    const b = handle({ spawnId: "b" });

    expect(batchKey([a, b])).toBe(batchKey([b, a]));
    expect(batchKey([a, b])).not.toBe(batchKey([a]));
    expect(batchKey([])).toBe("");
  });
});

describe("queued continuations", () => {
  const continuation: QueuedPrompt = { text: CONTINUATION_PROMPT, continuation: true };
  const typed: QueuedPrompt = { text: "what did the child do?", continuation: false };

  it("drops the continuations and keeps the user prompts", () => {
    const queue: QueuedPrompt[] = [continuation, typed, { ...continuation, text: "again" }];

    expect(dropContinuations(queue)).toBe(2);
    expect(queue).toEqual([typed]);
  });

  it("reports nothing dropped when the queue only holds user prompts", () => {
    const queue: QueuedPrompt[] = [typed];

    expect(dropContinuations(queue)).toBe(0);
    expect(queue).toEqual([typed]);
  });

  it("tells the user the continuation was discarded", () => {
    expect(CONTINUATION_DROPPED_NOTICE).toBe(
      "Discarded the automatic continuation: your prompt comes first.",
    );
  });

  it("empties a queue that only held continuations", () => {
    const queue: QueuedPrompt[] = [continuation];

    expect(dropContinuations(queue)).toBe(1);
    expect(queue).toEqual([]);
  });
});
