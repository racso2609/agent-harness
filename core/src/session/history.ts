import { History } from "@/types/providers";

export const DEFAULT_COMPACT_THRESHOLD = 4;

// Rough character-based token estimate used when the provider has not reported
// usage yet (for example right after resuming a persisted session).
export const estimateHistoryTokens = (messages: History[]) => {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);

  return Math.ceil(characters / 4);
};

export const summarizeHistory = (messages: History[], contextWindow?: number) => {
  const budget = contextWindow ? Math.min(Math.floor(contextWindow * 0.2), 200_000) : 16_000;
  const parts: string[] = [];
  let used = 0;

  for (const message of messages) {
    const content =
      message.content.length > 500 ? `${message.content.slice(0, 500)}…` : message.content;
    const part = `${message.role}: ${content}`;

    if (used + part.length > budget) break;

    parts.push(part);
    used += part.length + 3;
  }

  if (parts.length < messages.length) parts.push("…");

  return parts.join(" | ");
};

// Compacts the conversation: keeps system messages, folds older turns into a
// memory block and preserves the most recent window. Returns the same array
// reference when no compaction is needed.
export const compactHistory = (
  history: History[],
  compactThreshold = DEFAULT_COMPACT_THRESHOLD,
  contextWindow?: number,
): History[] => {
  const systemMessages: History[] = [];
  const conversation: History[] = [];

  for (const message of history) {
    if (message.role === "system") systemMessages.push(message);
    else conversation.push(message);
  }

  if (conversation.length <= compactThreshold) return history;

  // Never start the recent window with a tool result: it must stay paired
  // with the assistant message that requested it.
  let start = Math.max(0, conversation.length - compactThreshold);
  while (start > 0 && conversation[start].role === "tool") start--;

  const recentMessages = conversation.slice(start);
  const olderMessages = conversation.slice(0, start);
  const summaryText = summarizeHistory(olderMessages, contextWindow);

  const memoryBlock: History = {
    role: "system",
    content: `[Memoria previa compactada]: ${summaryText}`,
  };

  return [...systemMessages, memoryBlock, ...recentMessages];
};
