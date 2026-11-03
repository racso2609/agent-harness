import { describe, expect, it } from "vitest";
import type { SpawnHandle } from "@racso/core";
import {
autoContinuationLimitNotice,
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

// A fresh budget unless a test says otherwise: nothing spent against the
// default cap of 5.
const waiting = (
pending: SpawnHandle[],
hasUserDraft = false,
used = 0,
max: number | false = 5,
) =>
continuationDecision({
waitingForPrompt: true,
hasUserDraft,
pending,
budget: { used, max },
});

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

describe("automatic continuation cap", () => {
  it("continues below the cap", () => {
    // Four turns spent against a cap of 5 leaves room for exactly one more.
    expect(waiting([handle()], false, 4, 5)).toEqual({
      continue: true,
      notice: null,
    });
  });

  it("stops at the cap and says the number", () => {
    // Five spent is five started: a sixth turn is what the cap forbids.
    expect(waiting([handle()], false, 5, 5)).toEqual({
      continue: false,
      notice:
        "Stopping automatic continuation: reached maxAutoContinuations (5). Send a prompt to continue.",
    });
  });

  it("takes the number in the notice from the cap, not from the text", () => {
    expect(waiting([handle()], false, 2, 2)).toEqual({
      continue: false,
      notice:
        "Stopping automatic continuation: reached maxAutoContinuations (2). Send a prompt to continue.",
    });
  });

  it("stays stopped once the cap is exceeded", () => {
    // Nothing guarantees the counter stops exactly on the cap: any value at or
    // past it must keep the chain closed.
    expect(waiting([handle()], false, 7, 5)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(5),
    });
  });

  it("treats 0 as disabled", () => {
    // No budget at all: the very first continuation is refused.
    expect(waiting([handle()], false, 0, 0)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
    });
  });

  it("treats false as disabled at any count", () => {
    expect(waiting([handle()], false, 0, false)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
    });
    expect(waiting([handle()], false, 3, false)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
    });
  });

  it("lets a human prompt open a new budget", () => {
    // The loop resets the counter on a user prompt; here that is the same
    // decision with the counter back at 0 while the cap stays the same.
    const cap = 5;

    expect(waiting([handle()], false, 5, cap)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(5),
    });
    expect(waiting([handle()], false, 0, cap)).toEqual({
      continue: true,
      notice: null,
    });
  });

  it("keeps the waiting notice when the user types on a spent budget", () => {
    // Waiting outranks the cap: the user is writing, so the notice they see is
    // about their prompt, not about a stop that will not happen while they type.
    expect(waiting([handle()], true, 5, 5)).toEqual({
      continue: false,
      notice: DRAFT_WAITING_NOTICE,
    });
  });

  it("says nothing about the cap when no child left work", () => {
    // The cap explains why a turn would have started; with nothing to continue
    // there is no stop to announce.
    expect(waiting([], false, 5, 5)).toEqual({ continue: false, notice: null });
  });

  it("writes the cap notice in English with the interpolated number", () => {
    expect(autoContinuationLimitNotice(5)).toBe(
      "Stopping automatic continuation: reached maxAutoContinuations (5). Send a prompt to continue.",
    );
    expect(autoContinuationLimitNotice(12)).toBe(
      "Stopping automatic continuation: reached maxAutoContinuations (12). Send a prompt to continue.",
    );
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
