import type { SpawnHandle } from "@racso/core";

// The decision a turn of this session can be started without the user: when a
// child left work behind and nobody is holding the prompt loop. Kept pure and
// separate from MainLoop (which runs a stdin loop and cannot be mounted in a
// test) so the rules below are pinned by tests instead of by convention.

// The turn the session runs by itself once a child settles with work left.
export const CONTINUATION_PROMPT =
  "Continue with the work left by the children whose results you just received. If nothing is left, say so and stop.";

// Shown once per undelivered batch while the user is half-way through a
// thought: the continuation waits for them instead of stealing the turn.
export const DRAFT_WAITING_NOTICE =
  "A child left work behind; I will continue as soon as you send your prompt.";

// Shown when a queued continuation is dropped because the user sent a prompt.
export const CONTINUATION_DROPPED_NOTICE =
  "Discarded the automatic continuation: your prompt comes first.";

// One queued prompt. A continuation is marked so it can be dropped without
// touching what the user wrote; both travel through the same queue.
export interface QueuedPrompt {
  text: string;
  continuation: boolean;
}

// What the caller has to do with the undelivered children right now.
export interface ContinuationDecision {
  // Start a turn with CONTINUATION_PROMPT.
  continue: boolean;
  // Tell the user we are waiting for the prompt they are typing (at most once
  // per undelivered batch).
  notice: string | null;
}

// A child counts as work only when it succeeded with something to hand over:
// a failed child left nothing for the parent to continue.
const leftWork = (handle: SpawnHandle) =>
  handle.status === "done" && Boolean(handle.result?.trim());

// True when any of the undelivered children left work. The list, not its
// length, is what matters: an error-only batch has nothing to continue.
export const hasPendingWork = (pending: SpawnHandle[]) => pending.some(leftWork);

// Decides whether a turn starts on its own. `waitingForPrompt` is false while
// the loop is inside a turn (the approval dialog included): that settle is
// judged when the turn ends, never from the middle of it.
export const continuationDecision = (state: {
  waitingForPrompt: boolean;
  hasUserDraft: boolean;
  pending: SpawnHandle[];
}): ContinuationDecision => {
  const work = state.waitingForPrompt && hasPendingWork(state.pending);
  if (!work) return { continue: false, notice: null };
  if (state.hasUserDraft) return { continue: false, notice: DRAFT_WAITING_NOTICE };
  return { continue: true, notice: null };
};

// Identities of the undelivered children: the batch changes when a child
// joins or leaves it, which is when the waiting notice is owed again.
export const batchKey = (pending: SpawnHandle[]) =>
  pending
    .map((handle) => handle.spawnId)
    .sort()
    .join(",");

// Drops the queued continuations. Called before queueing a prompt the user
// typed: their prompt comes first and the continuation it found would only
// repeat the same work. Returns how many were dropped.
export const dropContinuations = (queue: QueuedPrompt[]) => {
  const dropped = queue.filter((entry) => entry.continuation).length;
  const kept = queue.filter((entry) => !entry.continuation);

  queue.length = 0;
  queue.push(...kept);

  return dropped;
};
