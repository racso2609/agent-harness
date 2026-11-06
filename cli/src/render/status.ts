import type { MemoryHit, SessionStatus, SessionSummary } from "@racso2609/core";

const numberFormat = new Intl.NumberFormat("en-US");

const formatTokens = (value: number) => numberFormat.format(Math.max(0, Math.round(value)));

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const formatCost = (value: number) => {
  const decimals = value > 0 && value < 0.01 ? 6 : 4;
  return `$${value.toFixed(decimals)}`;
};

const formatBar = (ratio: number, width = 16) => {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);

  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const formatSessionStatus = (status: SessionStatus) => {
  const agent = status.agent ? ` · agent ${status.agent}` : "";
  const provider = [status.provider, status.model].filter(Boolean).join(" / ");
  const percent = Math.round(status.contextUsage * 100);
  const window = status.contextWindow
    ? `${formatTokens(status.contextTokens)} / ${formatTokens(status.contextWindow)}`
    : `${formatTokens(status.contextTokens)} tokens`;
  const autoCompact = status.autoCompact
    ? ` · auto-compact at ${status.autoCompactThreshold}%`
    : "";

  return [
    `Session ${status.sessionId}${agent}${provider ? ` · ${provider}` : ""}`,
    `Tokens ${formatTokens(status.usage.inputTokens)} in · ${formatTokens(status.usage.outputTokens)} out · ${formatTokens(status.usage.totalTokens)} total · Cost ${formatCost(status.costUsd)}`,
    `Context ${formatBar(status.contextUsage)} ${percent}% (${window})${autoCompact}`,
  ].join("\n");
};

// Renders the persisted session list, marking the active one with "*".
const formatSessionList = (sessions: SessionSummary[], currentId?: string) => {
  if (!sessions.length) return "No sessions available";

  return sessions
    .map((session, index) => {
      const marker = session.id === currentId ? "*" : " ";
      const title = session.title ? ` — ${session.title}` : "";
      const agent = session.agentId ? ` · agent ${session.agentId}` : "";

      return [
        `${marker} ${index + 1}) ${session.id}${title}`,
        `    ${session.updatedAt} · ${session.provider}/${session.model}${agent} · ${session.messageCount} messages`,
      ].join("\n");
    })
    .join("\n");
};

// Health of the configured memory backend, plus the project key it will read
// and write. A down backend is a line to read, not an error: the detail is
// what the user needs to fix it.
const formatMemoryStatus = (status: {
  provider: string;
  ok: boolean;
  detail?: string;
  project?: string;
  projectSource?: string;
}) => {
  const state = status.ok ? "ok" : "down";
  const project = status.project
    ? `Project: ${status.project}${status.projectSource ? ` (${status.projectSource})` : ""}`
    : undefined;

  return [
    `Memory: ${status.provider} (${state})`,
    !status.ok && status.detail ? `Detail: ${status.detail}` : undefined,
    project,
  ]
    .filter(Boolean)
    .join("\n");
};

// One bullet per hit. The content is already capped by the provider, so it is
// only clipped here to keep the transcript readable.
const formatMemoryHits = (hits: MemoryHit[], query: string) => {
  if (!hits.length) return `No memories found for: "${query}"`;

  return hits
    .map((hit) => {
      const title = hit.title ? `**${hit.title}**` : "(untitled)";
      return `- [${hit.kind}] ${title}: ${truncate(hit.content, 200)}`;
    })
    .join("\n");
};

export {
  formatCost,
  formatMemoryHits,
  formatMemoryStatus,
  formatSessionList,
  formatSessionStatus,
  formatTokens,
};
