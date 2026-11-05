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

// Shown instead of starting another turn once the budget for automatic
// continuations is spent. The cap comes from the config: interpolating it keeps
// the message honest when a user changes it.
export const autoContinuationLimitNotice = (max: number) =>
  `Stopping automatic continuation: reached maxAutoContinuations (${max}). Send a prompt to continue.`;

// Shown when a queued continuation is dropped because the user sent a prompt.
export const CONTINUATION_DROPPED_NOTICE =
  "Discarded the automatic continuation: your prompt comes first.";

// One queued prompt. A continuation is marked so it can be dropped without
// touching what the user wrote; both travel through the same queue. It also
// remembers whether a draft change asked for it (not the same as the user
// sending a prompt) and which batch of children it waited for.
export interface QueuedPrompt {
  text: string;
  continuation: boolean;
  fromDraft?: boolean;
  batch?: SpawnHandle[];
}

// What the caller has to do with the undelivered children right now.
export interface ContinuationDecision {
  // Start a turn with CONTINUATION_PROMPT.
  continue: boolean;
  // Drop the continuation already handed to the loop: a prompt the user just
  // sent supersedes it, whatever the queue still holds.
  discard: boolean;
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

// Identities of the undelivered children: the batch changes when a child
// joins or leaves it, which is when the waiting notice is owed again.
export const batchKey = (pending: SpawnHandle[]) =>
  pending
    .map((handle) => handle.spawnId)
    .sort()
    .join(",");

// The children the queued continuations were waiting for: what the turn they
// start is about to deliver to the parent.
export const queuedBatch = (queue: QueuedPrompt[]): SpawnHandle[] =>
  queue.flatMap((entry) => entry.batch ?? []);

// Decides whether a turn starts on its own. `waitingForPrompt` is false while
// the loop is inside a turn (the approval dialog included), and also while the
// prompt it just took is still being answered: that settle is judged when the
// turn ends, never from the middle of it.
//
// `userSentPrompt` marks the end of a turn the user asked for: any
// continuation still owed is dropped, and the batch that turn delivered is not
// continued again, so the same work never runs twice.
//
// `budget` is what the loop already spent on automatic turns (`used`) and the
// cap from the config (`max`); `false` disables the feature, as does `0`. The
// cap is judged last on purpose: a user who is typing still owes the waiting
// notice, and a spent budget says nothing when there is no work to continue.
export const continuationDecision = (state: {
  waitingForPrompt: boolean;
  hasUserDraft: boolean;
  pending: SpawnHandle[];
  budget: { used: number; max: number | false };
  userSentPrompt?: boolean;
  // Set when only the draft change asked for the decision; a continuation it
  // queued says nothing about what the user sent.
  fromDraft?: boolean;
}): ContinuationDecision => {
  const no = { continue: false, notice: null, discard: false };

  if (state.userSentPrompt) return { ...no, discard: true };
  // Not waiting means mid-turn: queue nothing, but keep what is already queued,
  // since the loop answers a prompt that arrives behind ask() with it.
  if (!state.waitingForPrompt) return no;

  const key = batchKey(state.pending);
  // Nothing did arrive: the continuation in flight, if any, is still owed.
  if (!key) return no;

  // The batch was delivered by the turn that just ended, so there is nothing to
  // continue: a continuation queued for it is stale.
  if (!hasPendingWork(state.pending)) return { ...no, discard: true };
  if (state.hasUserDraft) return { ...no, notice: DRAFT_WAITING_NOTICE };

  const { used, max } = state.budget;
  // `false` and `0` are the same answer: the first continuation is already
  // over the cap, so the notice reports 0 rather than inventing a number.
  if (max === false || used >= max) {
    return { ...no, notice: autoContinuationLimitNotice(max === false ? 0 : max) };
  }
  return { ...no, continue: true };
};

// Index of the continuation a prompt the user sent supersedes: one queued
// before their prompt, or one the input box asked for when the send emptied
// it. `sentAt` is where the user prompt enters the queue, so a continuation
// queued behind it for a child settling later survives.
export const continuationToDrop = (queue: QueuedPrompt[], sentAt: number): number | null => {
  const index = queue.findIndex(
    (entry, position) =>
      entry.continuation &&
      (position < sentAt || (entry.fromDraft === true && position === sentAt)),
  );

  return index === -1 ? null : index;
};

// Drops those continuations. Called before queueing a prompt the user typed:
// their prompt comes first and the continuation it found would only repeat the
// same work. Returns how many were dropped.
export const dropContinuations = (queue: QueuedPrompt[], sentAt: number) => {
  const index = continuationToDrop(queue, sentAt);

  if (index === null) return 0;

  queue.splice(index, 1);
  return 1;
};
