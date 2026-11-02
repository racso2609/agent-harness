// Pure text helpers for the two closing notices of a turn: what happened to a
// child agent and how the turn itself ended. Both renderers share them so the
// line mode and the TUI never drift apart.

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
// summary and the transcript stays clean. Anything else reports the status,
// what is still pending and the concrete next step.
export const formatTurnOutcome = (outcome?: {
  status: string;
  pending: string[];
  next?: string;
}): string => {
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

  return parts.join(" · ");
};
