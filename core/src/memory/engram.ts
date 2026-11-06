import type { MemoryKind, MemoryScope } from "./Memory";

// Translation layer between our vocabulary (MemoryKind / MemoryScope) and the
// Engram HTTP API (observation `type` / `scope`). It lives in its own module so
// the mapping is testable without a server: everything here is pure.

// Engram's taxonomy is richer than ours. Every type it can emit must map to
// something, and an unknown one degrades to "fact" instead of throwing.
const KIND_TO_TYPE: Record<MemoryKind, string> = {
  fact: "discovery",
  decision: "decision",
  episode: "learning",
  preference: "preference",
};

const TYPE_TO_KIND: Record<string, MemoryKind> = {
  decision: "decision",
  bugfix: "fact",
  discovery: "fact",
  learning: "fact",
  pattern: "decision",
  architecture: "decision",
  config: "preference",
  preference: "preference",
};

const SCOPE_TO_ENGRAM: Record<MemoryScope, string> = {
  // Engram only knows project / personal / global. A session-scoped observation
  // has no Engram equivalent; the project scope is the closest bucket and the
  // session id still travels in `session_id`.
  user: "personal",
  project: "project",
  session: "project",
};

const ENGRAM_TO_SCOPE: Record<string, MemoryScope> = {
  project: "project",
  personal: "user",
  global: "user",
};

export const toEngramType = (kind: MemoryKind): string => KIND_TO_TYPE[kind] ?? "discovery";

export const fromEngramType = (type: string): MemoryKind => TYPE_TO_KIND[type] ?? "fact";

export const toEngramScope = (scope: MemoryScope): string => SCOPE_TO_ENGRAM[scope] ?? "project";

export const fromEngramScope = (scope: string): MemoryScope => ENGRAM_TO_SCOPE[scope] ?? "project";

export type QueryValue = string | number | boolean | undefined;

// Builds `<base><path>?k=v` skipping empty values, so a query string never
// carries `project=undefined` or an empty `q`. The base may carry a trailing
// slash, an already-mounted prefix (`/engram`) or nothing at all.
export const buildUrl = (
  base: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string => {
  const root = base.replace(/\/+$/, "");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${root}${path}?${search}` : `${root}${path}`;
};

export const buildSearchUrl = (
  base: string,
  params: { q: string; project?: string; limit?: number },
): string =>
  buildUrl(base, "/search", {
    q: params.q,
    project: params.project,
    response_format: "compact",
    limit: params.limit,
  });

export const buildContextUrl = (
  base: string,
  params: { project?: string; maxBytes?: number },
): string =>
  buildUrl(base, "/context", {
    project: params.project,
    compact: true,
    max_bytes: params.maxBytes,
  });
