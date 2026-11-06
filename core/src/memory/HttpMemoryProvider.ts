import { logger } from "@/utils/logger";
import {
  buildContextUrl,
  buildSearchUrl,
  buildUrl,
  fromEngramScope,
  fromEngramType,
  toEngramType,
} from "./engram";
import type {
  MemoryCapabilities,
  MemoryContextOptions,
  MemoryHit,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
} from "./Memory";
import { DEFAULT_MAX_HIT_CHARS } from "./LocalMemoryProvider";

// Adapted to Engram's HTTP API (verified against Engram 3.6.2). Only `fetch`
// and `AbortSignal.timeout`, both global on Node 18+: no dependency, and no
// listener left behind because `fetch` does not keep the event loop alive.
//
// The contract is the same as the local provider's: no method throws, a down
// backend is `[]` / `""` / `{ id: "" }` / `false`, and every request is bounded
// by `timeoutMs` so a hung server cannot hang the turn.

export const DEFAULT_TIMEOUT_MS = 5000;

const DEFAULT_SEARCH_LIMIT = 10;

export interface HttpMemoryProviderOptions {
  // Base URL of the Engram server, e.g. "http://127.0.0.1:7437".
  url: string;
  // Sent as `Authorization: Bearer <apikey>` on every request when present.
  apikey?: string;
  // Default project for searches, context and mutations. Engram requires
  // `expected_project` on deletes, so without it `forget` cannot work.
  project?: string;
  // Per-request budget. A timeout degrades exactly like a network error.
  timeoutMs?: number;
  // Cap on MemoryHit.content.
  maxHitChars?: number;
}

// Truncates without splitting a surrogate pair, so the result is always valid
// UTF-16 (and therefore valid UTF-8 once encoded).
const truncate = (text: string, max: number): string => {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut > 0 ? `${text.slice(0, cut)}…` : "";
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export class HttpMemoryProvider implements MemoryProvider {
  readonly id = "http";

  private readonly baseUrl: string;
  private readonly apikey?: string;
  private readonly project?: string;
  private readonly timeoutMs: number;
  private readonly maxHitChars: number;

  constructor(options: HttpMemoryProviderOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.apikey = options.apikey;
    this.project = options.project;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxHitChars = options.maxHitChars ?? DEFAULT_MAX_HIT_CHARS;
  }

  capabilities(): MemoryCapabilities {
    return {
      search: true,
      context: true,
      capture: true,
      forget: true,
      // Engram searches with FTS5: terms, not meanings.
      semantic: false,
      scopes: ["user", "project", "session"],
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await this.request("GET", "/health");
      if (!response) return { ok: false, detail: "no response from memory backend" };
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
      const body = asRecord(await response.json());
      if (body.status !== "ok") {
        return { ok: false, detail: `unexpected status: ${String(body.status)}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: this.reason(error) };
    }
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    try {
      const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_SEARCH_LIMIT;
      const url = buildSearchUrl(this.baseUrl, {
        q: query.text,
        project: query.project ?? this.project,
        limit,
      });
      const response = await this.request("GET", url);
      if (!response || !response.ok) return [];
      const body = asRecord(await response.json());
      const results = Array.isArray(body.results) ? body.results : [];
      const hits: MemoryHit[] = [];
      for (const entry of results) {
        const row = asRecord(entry);
        // Engram ids are numeric; the interface wants a string.
        const id = row.id === undefined || row.id === null ? "" : String(row.id);
        if (!id) continue;
        const scope = fromEngramScope(asString(row.scope));
        if (query.scope && query.scope !== scope) continue;
        const kind = fromEngramType(asString(row.type));
        if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(kind)) continue;
        const hit: MemoryHit = {
          id,
          kind,
          scope,
          title: asString(row.title),
          content: truncate(asString(row.preview), this.maxHitChars),
        };
        const createdAt = asString(row.created_at);
        if (createdAt) hit.createdAt = createdAt;
        if (this.project) hit.project = this.project;
        hits.push(hit);
      }
      return hits;
    } catch {
      return [];
    }
  }

  async context(options: MemoryContextOptions): Promise<string> {
    try {
      if (options.maxChars <= 0) return "";
      const url = buildContextUrl(this.baseUrl, {
        project: options.project ?? this.project,
        maxBytes: options.maxChars,
      });
      const response = await this.request("GET", url);
      if (!response || !response.ok) return "";
      const body = asRecord(await response.json());
      // `maxBytes` is what we asked for, but the cap is ours to enforce: the
      // contract says the provider never returns more than maxChars, the
      // ellipsis included.
      return truncate(asString(body.context), Math.max(options.maxChars - 1, 0));
    } catch {
      return "";
    }
  }

  async capture(observation: MemoryObservation): Promise<{ id: string }> {
    try {
      const payload: Record<string, unknown> = {
        session_id: observation.sessionId ?? "",
        type: toEngramType(observation.kind),
        title: observation.title,
        content: observation.content,
        project: observation.project ?? this.project ?? "",
      };
      const response = await this.request("POST", "/observations", payload);
      if (!response || !response.ok) return { id: "" };
      const body = asRecord(await response.json());
      const id = body.id === undefined || body.id === null ? "" : String(body.id);
      return { id };
    } catch {
      return { id: "" };
    }
  }

  async forget(id: string): Promise<boolean> {
    try {
      if (!id) return false;
      // Engram refuses mutations without `expected_project`.
      if (!this.project) {
        logger.warn("Memory backend requires memory.project to delete an observation");
        return false;
      }
      const url = buildUrl(this.baseUrl, `/observations/${encodeURIComponent(id)}`, {
        expected_project: this.project,
      });
      const response = await this.request("DELETE", url);
      if (!response || !response.ok) return false;
      const body = asRecord(await response.json());
      // Engram hides the observation instead of dropping it. Reporting `true`
      // here would tell the caller the memory is gone when it is only hidden.
      return body.hard_delete !== false;
    } catch {
      return false;
    }
  }

  // Nothing persistent to release: `fetch` opens and closes per request.
  async close(): Promise<void> {}

  // One place for the headers, the timeout and the "does it even answer"
  // check. Returns null instead of throwing so every caller degrades the same.
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response | null> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apikey) headers.Authorization = `Bearer ${this.apikey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return globalThis.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private reason(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
