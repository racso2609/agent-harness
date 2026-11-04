import type { UiStatus } from "./UiAdapter";

// One-line status bar shared by both renderers. The TUI paints it in the single
// row under the input box and the line renderer prints it as a notice, so the
// two used to drift apart when each one grew its own copy. It is a pure
// function of the snapshot: the renderers only decide where the line goes.

// Long enough to tell two sessions apart at a glance, short enough to leave
// room for the context percentage on a narrow terminal. `/status` still shows
// the full id.
const SHORT_ID = 8;

// The prefix is constant across every session, so cutting by position would
// show "session-" for each one and never the identity; it has to be stripped
// first. Ids without the prefix are abbreviated as they come, since tests and
// external callers are not forced to follow the generator's format.
const SESSION_PREFIX = "session-";

const abbreviateSession = (sessionId: string): string => {
const bare = sessionId.startsWith(SESSION_PREFIX)
? sessionId.slice(SESSION_PREFIX.length)
: sessionId;

return bare.slice(0, SHORT_ID);
};

// Compact token counts: the bar has one row, so "12345" is noise and "12.3k" is
// the same information. A tenth is only kept when it is not a zero one, so
// whole thousands stay "12k" instead of "12.0k".
const formatCompactTokens = (value: number): string => {
const tokens = Math.max(0, Math.round(value));

if (tokens < 1_000) return String(tokens);

const scaled = tokens / 1_000;
if (scaled < 10) return `${trimZero(scaled)}k`;
if (scaled < 1_000) return `${Math.round(scaled)}k`;

return `${trimZero(scaled / 1_000)}M`;
};

const trimZero = (value: number): string =>
(value >= 10 ? String(Math.round(value)) : value.toFixed(1)).replace(/\.0$/, "");

// The context part is the reason this module exists: the percentage is only
// meaningful against a known window, so without one the whole part is dropped
// instead of printing a "0%" that would be a lie.
const contextPart = (status: UiStatus): string | null => {
if (status.contextUsage == null) return null;

const percent = Math.round(Math.max(0, Math.min(1, status.contextUsage)) * 100);
const occupancy =
status.contextWindow != null && status.contextTokens != null
? ` ${formatCompactTokens(status.contextTokens)}/${formatCompactTokens(status.contextWindow)}`
: "";
const autoCompact = autoCompactMark(status);

return `ctx ${percent}%${occupancy}${autoCompact}`;
};

// Auto-compact is already automatic, so the bar only warns once the threshold
// has been crossed: the mark then explains why the session is about to be
// compacted instead of why it still runs as usual.
const autoCompactMark = (status: UiStatus): string => {
if (!status.autoCompact || status.autoCompactThreshold == null) return "";
if (status.contextUsage == null) return "";

const percent = status.contextUsage * 100;
if (percent < status.autoCompactThreshold) return "";

return ` auto-compact @${status.autoCompactThreshold}%`;
};

// Builds the single line. Every part is optional and skipped when absent, so a
// snapshot that only carries the provider still paints something useful.
// Empty means "nothing to say": the TUI falls back to "ready" and the line
// renderer stays silent instead of printing a decorative blank line.
const formatStatusBar = (status: UiStatus): string => {
const parts: string[] = [];

if (status.sessionId) parts.push(`ses ${abbreviateSession(status.sessionId)}`);

const model = [status.provider, status.model].filter(Boolean).join("/");
if (model) parts.push(model);

if (status.agent) parts.push(status.agent);
if (status.tokens != null) parts.push(`${formatCompactTokens(status.tokens)} tok`);
if (status.costUsd != null) parts.push(`$${status.costUsd.toFixed(4)}`);

const context = contextPart(status);
if (context) parts.push(context);

return parts.join(" · ");
};

export { abbreviateSession, formatCompactTokens, formatStatusBar };
