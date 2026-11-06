import type { History } from "@/types/providers";

// Marker that opens every injected memory block. It is the only thing that
// tells an injected block apart from any other system message, so stripping
// history before injecting is what makes the injection idempotent.
export const MEMORY_BLOCK_PREFIX = "[Memoria del proyecto]";

// History without the memory blocks of a previous injection. Returns a new
// array: the caller's history is never mutated in place.
export const stripMemoryBlocks = (history: History[]): History[] =>
  history.filter(
    (message) => !(message.role === "system" && message.content.startsWith(MEMORY_BLOCK_PREFIX)),
  );

// The system message that carries the provider context into the history.
export const composeMemoryBlock = (text: string): History => ({
  role: "system",
  content: `${MEMORY_BLOCK_PREFIX}\n${text}`,
});
