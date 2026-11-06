import { History } from "@/types/providers";

export const DEFAULT_COMPACT_THRESHOLD = 4;

// Prefix of the system block that holds the folded older turns. A new
// compaction replaces the previous block instead of stacking another summary
// of the same conversation on top of it.
export const COMPACTED_MEMORY_PREFIX = "[Memoria previa compactada]";

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

export interface CompactedHistory {
  history: History[];
  // The folded text of the older turns, or "" when nothing was compacted.
  summary: string;
  // First user message of the folded window, trimmed, or "" when none.
  title: string;
}

// Longest title handed to a memory backend: a compaction title is a label, not
// the whole turn.
export const MAX_TITLE_CHARS = 100;

// First user turn of the folded window is the session's opening request, so it
// is the best one-line label for what got compacted. It must come from
// olderMessages: the compacted history starts with the recent window, whose
// first user is a later turn.
const compactionTitle = (messages: History[]) => {
  const first = messages.find((message) => message.role === "user");
  const text = first?.content.trim() ?? "";

  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS)}…` : text;
};

// Compacts the conversation: keeps system messages, folds older turns into a
// memory block and preserves the most recent window. Returns the same array
// reference when no compaction is needed. Previous compaction blocks are
// dropped: the new one supersedes them, otherwise every compaction would add
// another summary of the same conversation and grow the context it is meant
// to shrink.
export const compactHistoryWithSummary = (
  history: History[],
  compactThreshold = DEFAULT_COMPACT_THRESHOLD,
  contextWindow?: number,
): CompactedHistory => {
  const systemMessages: History[] = [];
  const conversation: History[] = [];

  for (const message of history) {
    if (message.role !== "system") {
      conversation.push(message);
      continue;
    }
    // A previous compaction block is superseded by the one built below:
    // keeping it would stack another summary of the same conversation on
    // every pass and grow the context compaction exists to shrink.
    if (message.content.startsWith(COMPACTED_MEMORY_PREFIX)) continue;
    systemMessages.push(message);
  }

  if (conversation.length <= compactThreshold) return { history, summary: "", title: "" };

  // Never start the recent window with a tool result: it must stay paired
  // with the assistant message that requested it.
  let start = Math.max(0, conversation.length - compactThreshold);
  while (start > 0 && conversation[start].role === "tool") start--;

  const recentMessages = conversation.slice(start);
  const olderMessages = conversation.slice(0, start);
  const summaryText = summarizeHistory(olderMessages, contextWindow);

  const memoryBlock: History = {
    role: "system",
    content: `${COMPACTED_MEMORY_PREFIX}: ${summaryText}`,
  };

  return {
    history: [...systemMessages, memoryBlock, ...recentMessages],
    summary: summaryText,
    title: compactionTitle(olderMessages),
  };
};

export const compactHistory = (
  history: History[],
  compactThreshold = DEFAULT_COMPACT_THRESHOLD,
  contextWindow?: number,
): History[] => compactHistoryWithSummary(history, compactThreshold, contextWindow).history;
