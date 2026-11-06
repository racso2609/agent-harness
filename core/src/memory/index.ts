import type { MemoryConfig } from "@/configuration";
import { logger } from "@/utils/logger";
import { LocalMemoryProvider } from "./LocalMemoryProvider";
import { NoopMemoryProvider } from "./NoopMemoryProvider";
import type { MemoryProvider } from "./Memory";

export { composeMemoryBlock, MEMORY_BLOCK_PREFIX, stripMemoryBlocks } from "./context";
export { LocalMemoryProvider, DEFAULT_MAX_HIT_CHARS } from "./LocalMemoryProvider";
export type { LocalMemoryProviderOptions } from "./LocalMemoryProvider";
export { NoopMemoryProvider } from "./NoopMemoryProvider";
export type {
  MemoryCapabilities,
  MemoryContextOptions,
  MemoryHit,
  MemoryKind,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
  MemoryScope,
} from "./Memory";

// Resolves the `memory` config block to an implementation. Never throws: an
// unknown or not-yet-implemented backend degrades to the no-op provider so the
// rest of the harness can always hold one.
export const createMemoryProvider = (config: MemoryConfig | undefined): MemoryProvider => {
  if (!config || config.enabled === false) return new NoopMemoryProvider();

  switch (config.provider) {
    case "local":
      return new LocalMemoryProvider({
        path: config.path,
        maxHitChars: config.maxHitChars,
      });
    case "http":
    case "mcp":
      // F-M4 (http) and F-M5 (mcp) implement these. Until then, warn once
      // per call and behave like memory turned off.
      logger.warn(`Memory provider "${config.provider}" is not implemented yet; disabling memory`);
      return new NoopMemoryProvider();
    default:
      return new NoopMemoryProvider();
  }
};
