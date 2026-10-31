import type { SessionStatus } from "@/types/session";

const numberFormat = new Intl.NumberFormat("en-US");

const formatTokens = (value: number) =>
  numberFormat.format(Math.max(0, Math.round(value)));

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

export { formatCost, formatSessionStatus, formatTokens };
