import { describe, expect, it } from "vitest";
import type { SpawnHandle } from "@racso/core";
import {
  autoContinuationLimitNotice,
  batchKey,
  CONTINUATION_DROPPED_NOTICE,
  CONTINUATION_PROMPT,
  continuationDecision,
  continuationToDrop,
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
const waiting = (pending: SpawnHandle[], hasUserDraft = false, used = 0, max: number | false = 5) =>
  continuationDecision({
    waitingForPrompt: true,
    hasUserDraft,
    pending,
    budget: { used, max },
  });

describe("continuation", () => {
  it("continues when an undelivered child left a result", () => {
    expect(waiting([handle()])).toEqual({ continue: true, notice: null, discard: false });
  });

  it("does not continue for a child that failed", () => {
    // A failed child hands nothing over; the user decides what to do with it.
    const failed = [handle({ status: "error", result: undefined, error: "provider down" })];

    expect(hasPendingWork(failed)).toBe(false);
    expect(waiting(failed)).toEqual({ continue: false, notice: null, discard: true });
  });

  it("does not continue for a successful child with an empty result", () => {
    expect(waiting([handle({ result: " " })])).toEqual({
      continue: false,
      notice: null,
      discard: true,
    });
  });

  it("does not continue with nothing undelivered", () => {
    // A settle that just arrived must not fire once another path already
    // delivered it: the empty list is the answer, and it leaves the
    // continuation in flight alone because nothing arrived to make it stale.
    expect(waiting([])).toEqual({ continue: false, notice: null, discard: false });
  });

  it("keeps waiting while the loop is inside a turn", () => {
    // The child settled mid-turn: the end of that turn judges it, not the
    // settle itself, or two turns would race for the same history.
    expect(
      continuationDecision({ waitingForPrompt: false, hasUserDraft: false, pending: [handle()] }),
    ).toEqual({ continue: false, notice: null, discard: false });
  });

  it("waits and says so when the user is typing", () => {
    expect(waiting([handle()], true)).toEqual({
      continue: false,
      notice: DRAFT_WAITING_NOTICE,
      discard: false,
    });
  });

  it("announces the same text for a batch of several children", () => {
    const batch = [handle({ spawnId: "a" }), handle({ spawnId: "b", status: "error" })];

    expect(waiting(batch, true)).toEqual({
      continue: false,
      notice: DRAFT_WAITING_NOTICE,
      discard: false,
    });
  });

  it("starts one single turn for every undelivered child", () => {
    // The decision speaks for the whole batch: there is no per-child verdict
    // that could turn one settle into three turns.
    const batch = [handle({ spawnId: "a" }), handle({ spawnId: "b" })];

    expect(waiting(batch)).toEqual({ continue: true, notice: null, discard: false });
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

describe("prompts the user sends", () => {
  const sent = (pending: SpawnHandle[], hasUserDraft = false) =>
    continuationDecision({
      waitingForPrompt: true,
      hasUserDraft,
      pending,
      budget: { used: 0, max: 5 },
      userSentPrompt: true,
    });

  it("discards the continuation still owed instead of continuing", () => {
    // Their prompt supersedes it: the work it would do runs under the prompt
    // they just sent, so a second turn would repeat it.
    expect(sent([handle()])).toEqual({ continue: false, notice: null, discard: true });
  });

  it("discards even when no child left work", () => {
    // A continuation queued for a batch that turned out to be error-only still
    // must not run: the verdict does not depend on there being work left.
    expect(sent([handle({ status: "error", result: undefined })])).toEqual({
      continue: false,
      notice: null,
      discard: true,
    });
  });

  it("discards instead of announcing it is waiting for a draft", () => {
    // A send empties the box, so the draft the box reports right then must not
    // turn the discarded continuation into a promise to continue later.
    expect(sent([handle()], true)).toEqual({ continue: false, notice: null, discard: true });
  });

  it("does not read a draft change as a prompt the user sent", () => {
    // The box reports every keystroke: only an actual send drops an owed turn.
    expect(
      continuationDecision({
        waitingForPrompt: true,
        hasUserDraft: false,
        pending: [handle()],
        budget: { used: 0, max: 5 },
        fromDraft: true,
      }),
    ).toEqual({ continue: true, notice: null, discard: false });
  });
});

describe("automatic continuation cap", () => {
  it("continues below the cap", () => {
    // Four turns spent against a cap of 5 leaves room for exactly one more.
    expect(waiting([handle()], false, 4, 5)).toEqual({
      continue: true,
      notice: null,
      discard: false,
    });
  });

  it("stops at the cap and says the number", () => {
    // Five spent is five started: a sixth turn is what the cap forbids.
    expect(waiting([handle()], false, 5, 5)).toEqual({
      continue: false,
      notice:
        "Stopping automatic continuation: reached maxAutoContinuations (5). Send a prompt to continue.",
      discard: false,
    });
  });

  it("takes the number in the notice from the cap, not from the text", () => {
    expect(waiting([handle()], false, 2, 2)).toEqual({
      continue: false,
      notice:
        "Stopping automatic continuation: reached maxAutoContinuations (2). Send a prompt to continue.",
      discard: false,
    });
  });

  it("stays stopped once the cap is exceeded", () => {
    // Nothing guarantees the counter stops exactly on the cap: any value at or
    // past it must keep the chain closed.
    expect(waiting([handle()], false, 7, 5)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(5),
      discard: false,
    });
  });

  it("treats 0 as disabled", () => {
    // No budget at all: the very first continuation is refused.
    expect(waiting([handle()], false, 0, 0)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
      discard: false,
    });
  });

  it("treats false as disabled at any count", () => {
    expect(waiting([handle()], false, 0, false)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
      discard: false,
    });
    expect(waiting([handle()], false, 3, false)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(0),
      discard: false,
    });
  });

  it("lets a human prompt open a new budget", () => {
    // The loop resets the counter on a user prompt; here that is the same
    // decision with the counter back at 0 while the cap stays the same.
    const cap = 5;

    expect(waiting([handle()], false, 5, cap)).toEqual({
      continue: false,
      notice: autoContinuationLimitNotice(5),
      discard: false,
    });
    expect(waiting([handle()], false, 0, cap)).toEqual({
      continue: true,
      notice: null,
      discard: false,
    });
  });

  it("keeps the waiting notice when the user types on a spent budget", () => {
    // Waiting outranks the cap: the user is writing, so the notice they see is
    // about their prompt, not about a stop that will not happen while they type.
    expect(waiting([handle()], true, 5, 5)).toEqual({
      continue: false,
      notice: DRAFT_WAITING_NOTICE,
      discard: false,
    });
  });

  it("says nothing about the cap when no child left work", () => {
    // The cap explains why a turn would have started; with nothing to continue
    // there is no stop to announce.
    expect(waiting([], false, 5, 5)).toEqual({ continue: false, notice: null, discard: false });
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

  it("drops the continuation waiting ahead of the prompt the user sent", () => {
    // The user prompt enters the queue at the end: the continuation sitting
    // before that point is the one it supersedes, and only that one.
    const queue: QueuedPrompt[] = [continuation, typed, continuation];

    expect(continuationToDrop(queue, 1)).toBe(0);
    expect(dropContinuations(queue, 1)).toBe(1);
    expect(queue).toEqual([typed, continuation]);
  });

  it("keeps a continuation queued behind the prompt the user sent", () => {
    // A child settled after the send, so its work was never part of what the
    // prompt covers: dropping it would lose a turn the user still owes.
    const queue: QueuedPrompt[] = [typed, continuation];

    expect(continuationToDrop(queue, 1)).toBeNull();
    expect(dropContinuations(queue, 1)).toBe(0);
    expect(queue).toEqual([typed, continuation]);
  });

  it("drops the continuation the emptied draft queued in the send's place", () => {
    // Sending empties the box and reports it, and that draft edge can queue a
    // continuation right where the prompt lands: it is the same supersession.
    const fromDraft: QueuedPrompt = { ...continuation, fromDraft: true };
    const queue: QueuedPrompt[] = [typed, fromDraft];

    expect(continuationToDrop(queue, 1)).toBe(1);
    expect(dropContinuations(queue, 1)).toBe(1);
    expect(queue).toEqual([typed]);
  });

  it("reports nothing dropped when the queue only holds user prompts", () => {
    const queue: QueuedPrompt[] = [typed];

    expect(continuationToDrop(queue, 1)).toBeNull();
    expect(dropContinuations(queue, 1)).toBe(0);
    expect(queue).toEqual([typed]);
  });

  it("reports nothing dropped when there is no continuation to drop", () => {
    const queue: QueuedPrompt[] = [];

    expect(continuationToDrop(queue, 0)).toBeNull();
    expect(dropContinuations(queue, 0)).toBe(0);
    expect(queue).toEqual([]);
  });

  it("tells the user the continuation was discarded", () => {
    expect(CONTINUATION_DROPPED_NOTICE).toBe(
      "Discarded the automatic continuation: your prompt comes first.",
    );
  });

  it("empties a queue that only held continuations", () => {
    // One at a time: the caller repeats until it reports none, so a queue of
    // continuations drains to empty without reporting more than it dropped.
    const fromDraft: QueuedPrompt = { ...continuation, text: "again", fromDraft: true };
    const queue: QueuedPrompt[] = [continuation, fromDraft];

    expect(dropContinuations(queue, queue.length)).toBe(1);
    expect(dropContinuations(queue, queue.length)).toBe(1);
    expect(dropContinuations(queue, queue.length)).toBe(0);
    expect(queue).toEqual([]);
  });
});
