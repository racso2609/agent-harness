// Pure text helpers for the two closing notices of a turn: what happened to a
// child agent and how the turn itself ended. Both renderers share them so the
// line mode and the TUI never drift apart.

// Appended to the closing line of a turn that was started without the user and
// that will be followed by another turn of the same chain: without it a silent
// screen reads as a stopped process.
export const CONTINUING_ALONE_NOTICE = "session continues on its own";

// A settled child can carry a long, multi-line result; the transcript only
// gets one readable line of it.
export const MAX_OUTCOME_CHARS = 200;

// Collapses every run of whitespace (newlines included) into one space and
// caps the length, marking the elision.
export const oneLine = (text: string, max = MAX_OUTCOME_CHARS): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();

  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
};

// A child can come back with nothing useful: undefined (never set) and an
// empty or blank string are the same case, so both fall back to a placeholder
// instead of leaving a header with no body.
const outcomeText = (value: string | undefined, fallback: string) =>
  value && value.trim() ? value : fallback;

// One line describing how a child finished: status, agent, id and outcome.
export const formatSpawnOutcome = (handle: {
  spawnId: string;
  agentId: string;
  status: string;
  result?: string;
  error?: string;
}): string => {
  const header = `spawn ${handle.spawnId} ${handle.status} (${handle.agentId})`;

  if (handle.status === "error") {
    return `${header}: ${oneLine(outcomeText(handle.error, "unknown error"))}`;
  }

  if (handle.status === "done") {
    return `${header}: ${oneLine(outcomeText(handle.result, "(no output)"))}`;
  }

  return header;
};

// Closing line of a turn. A completed turn says nothing: the answer is the
// summary and the transcript stays clean. That holds with `more` and without
// it, because the answer already tells what happened and the next turn closes
// in its place.
//
// Anything else reports the status, what is still pending and the concrete
// next step. `more` is the only thing that adds CONTINUING_ALONE_NOTICE to
// that close: the function has no notion of "the last turn of the chain"
// versus "an intermediate turn". Both close with exactly the same text; the
// notice is the only difference, and whether it appears is decided by whoever
// calls the function, not by the format itself.
export const formatTurnOutcome = (
  outcome?: {
    status: string;
    pending: string[];
    next?: string;
  },
  more = false,
): string => {
  if (!outcome || outcome.status === "completed") return "";

  const label =
    outcome.status === "toolError"
      ? "turn failed"
      : outcome.status === "incomplete"
        ? "turn incomplete"
        : `turn ${outcome.status}`;

  const parts = [label];

  if (outcome.pending.length) parts.push(`pending: ${outcome.pending.join(", ")}`);
  if (outcome.next) parts.push(`next: ${outcome.next}`);
  if (more) parts.push(CONTINUING_ALONE_NOTICE);

  return parts.join(" · ");
};
