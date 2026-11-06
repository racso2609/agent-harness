import type { MemoryConfig } from "@/configuration";
import { logger } from "@/utils/logger";
import { HttpMemoryProvider } from "./HttpMemoryProvider";
import { LocalMemoryProvider } from "./LocalMemoryProvider";
import { NoopMemoryProvider } from "./NoopMemoryProvider";
import type { MemoryProvider } from "./Memory";

export { composeMemoryBlock, MEMORY_BLOCK_PREFIX, stripMemoryBlocks } from "./context";
export { HttpMemoryProvider, DEFAULT_TIMEOUT_MS } from "./HttpMemoryProvider";
export type { HttpMemoryProviderOptions } from "./HttpMemoryProvider";
export {
  buildContextUrl,
  buildSearchUrl,
  buildUrl,
  fromEngramScope,
  fromEngramType,
  toEngramScope,
  toEngramType,
} from "./engram";
export { LocalMemoryProvider, DEFAULT_MAX_HIT_CHARS } from "./LocalMemoryProvider";
export type { LocalMemoryProviderOptions } from "./LocalMemoryProvider";
export { NoopMemoryProvider } from "./NoopMemoryProvider";
export { normalizeGitRemote, readGitRemote, resolveProjectIdentity } from "./project";
export { redact } from "./redact";
export type {
  ProjectIdentity,
  ProjectIdentitySource,
  ResolveProjectIdentityOptions,
} from "./project";
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
      if (!config.url) {
        logger.warn('Memory provider "http" needs memory.url; disabling memory');
        return new NoopMemoryProvider();
      }
      return new HttpMemoryProvider({
        url: config.url,
        apikey: config.apikey,
        project: config.project,
        timeoutMs: config.timeoutMs,
        maxHitChars: config.maxHitChars,
      });
    case "mcp":
      // F-M5 (mcp) implements this. Until then, warn once per call and behave
      // like memory turned off.
      logger.warn(`Memory provider "${config.provider}" is not implemented yet; disabling memory`);
      return new NoopMemoryProvider();
    default:
      return new NoopMemoryProvider();
  }
};
