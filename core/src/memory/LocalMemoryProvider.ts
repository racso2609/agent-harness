import fs from "node:fs";
import path from "node:path";
import { memoryHome } from "@/utils/env";
import type {
  MemoryCapabilities,
  MemoryContextOptions,
  MemoryHit,
  MemoryKind,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
  MemoryScope,
} from "./Memory";
import { applyPragmas, migrate, type SqliteDatabase } from "./schema";

// Cap applied to a hit's `content` when the caller does not pass one. The
// provider cannot read config (that is SessionManager's job), so the value
// arrives through the constructor.
export const DEFAULT_MAX_HIT_CHARS = 1200;

// How many observations `context()` looks at before truncating. It reads more
// than `maxChars` will hold so a tight budget still yields the newest ones.
const CONTEXT_CANDIDATES = 20;

const DEFAULT_SEARCH_LIMIT = 10;

export interface LocalMemoryProviderOptions {
  // SQLite file. Defaults to memoryHome() (RACSO_HARNESS_MEMORY_LOCATION).
  path?: string;
  // Cap on MemoryHit.content.
  maxHitChars?: number;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asNullableString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// Truncates without splitting a surrogate pair, so the result is always valid
// UTF-16 (and therefore valid UTF-8 once encoded).
const truncate = (text: string, max: number): string => {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  // High surrogate at the boundary: drop it, its pair is out of budget.
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut > 0 ? `${text.slice(0, cut)}…` : "";
};

/**
 * Turns arbitrary user text into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own grammar (quotes, `*`, `AND`/`OR`/`NOT`, `NEAR`, parentheses,
 * column filters) and a stray token makes MATCH throw. Rather than escaping the
 * grammar we drop it: every run of letters/digits becomes a bare term, and the
 * terms are OR-joined, which is what a user typing "deploy how" expects. An
 * empty result means the query has nothing searchable and the caller returns [].
 */
export const toFtsQuery = (text: string): string => {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  // A lone "-" or "_" survives the character class but is not a term.
  const cleaned = terms.filter((term) => /[\p{L}\p{N}]/u.test(term));
  return cleaned.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
};

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";

  private readonly dbPath: string;
  private readonly maxHitChars: number;
  private db: SqliteDatabase | null = null;
  private openFailed = false;
  private opening: Promise<SqliteDatabase | null> | null = null;

  constructor(options: LocalMemoryProviderOptions = {}) {
    this.dbPath = options.path ?? memoryHome();
    this.maxHitChars = options.maxHitChars ?? DEFAULT_MAX_HIT_CHARS;
  }

  capabilities(): MemoryCapabilities {
    return {
      search: true,
      context: true,
      capture: true,
      forget: true,
      // FTS5 matches terms, not meanings.
      semantic: false,
      scopes: ["user", "project", "session"],
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const db = await this.open();
    if (!db) return { ok: false, detail: "node:sqlite is not available on this Node version" };
    return { ok: true };
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    try {
      const db = await this.open();
      if (!db) return [];

      const match = toFtsQuery(query.text);
      if (!match) return [];

      const where: string[] = ["observations_fts MATCH ?"];
      const params: unknown[] = [match];
      if (query.scope) {
        where.push("o.scope = ?");
        params.push(query.scope);
      }
      if (query.project) {
        where.push("o.project = ?");
        params.push(query.project);
      }
      if (query.sessionId) {
        where.push("o.session_id = ?");
        params.push(query.sessionId);
      }
      if (query.kinds && query.kinds.length > 0) {
        where.push(`o.kind IN (${query.kinds.map(() => "?").join(", ")})`);
        params.push(...query.kinds);
      }
      const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_SEARCH_LIMIT;
      params.push(limit);

      const rows = db
        .prepare(
          `SELECT o.id, o.kind, o.scope, o.title, o.content, o.project, o.created_at,
						bm25(observations_fts) AS rank
					FROM observations_fts
					JOIN observations o ON o.id = observations_fts.rowid
					WHERE ${where.join(" AND ")}
					ORDER BY rank
					LIMIT ?`,
        )
        .all(...params);

      return rows.map((row) => this.toHit(row));
    } catch {
      // A MATCH syntax error or a broken database degrades to "no results".
      return [];
    }
  }

  async context(options: MemoryContextOptions): Promise<string> {
    try {
      const db = await this.open();
      if (!db) return "";
      if (options.maxChars <= 0) return "";

      const where: string[] = [];
      const params: unknown[] = [];
      if (options.project) {
        where.push("o.project = ?");
        params.push(options.project);
      }
      if (options.scope) {
        where.push("o.scope = ?");
        params.push(options.scope);
      }
      params.push(CONTEXT_CANDIDATES);

      const rows = db
        .prepare(
          `SELECT o.id, o.kind, o.scope, o.title, o.content, o.project, o.created_at
					FROM observations o
					${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
					ORDER BY o.created_at DESC, o.id DESC
					LIMIT ?`,
        )
        .all(...params);

      if (rows.length === 0) return "";

      const lines = ["## Memoria del proyecto", ""];
      for (const row of rows) {
        const kind = asString(row.kind) || "fact";
        const title = asString(row.title) || asString(row.content).slice(0, 80);
        const preview = asString(row.content).replace(/\s+/g, " ").slice(0, 200);
        lines.push(`- [${kind}] **${title}** — ${preview}`);
      }
      const block = `${lines.join("\n")}\n`;

      // Honour maxChars strictly, and cut on a line boundary when possible
      // so the block never ends mid-bullet.
      if (block.length <= options.maxChars) return block;
      const hard = truncate(block, options.maxChars);
      const lastBreak = hard.lastIndexOf("\n");
      return lastBreak > 0 ? hard.slice(0, lastBreak + 1) : hard;
    } catch {
      return "";
    }
  }

  // With a `topicKey` this is an upsert: the unique partial index on
  // topic_key is the conflict target, which is why the ON CONFLICT clause
  // repeats its WHERE predicate.
  async capture(observation: MemoryObservation): Promise<{ id: string }> {
    try {
      const db = await this.open();
      if (!db) return { id: "" };

      const now = new Date().toISOString();
      const row = observation.topicKey
        ? db
            .prepare(
              `INSERT INTO observations
								(kind, scope, project, session_id, title, content, topic_key, created_at, updated_at)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT(topic_key) WHERE topic_key IS NOT NULL DO UPDATE SET
								title = excluded.title,
								content = excluded.content,
								kind = excluded.kind,
								scope = excluded.scope,
								project = excluded.project,
								session_id = excluded.session_id,
								updated_at = excluded.updated_at,
								revision_count = revision_count + 1
							RETURNING id`,
            )
            .get(
              observation.kind,
              observation.scope,
              observation.project ?? null,
              observation.sessionId ?? null,
              observation.title,
              observation.content,
              observation.topicKey,
              now,
              now,
            )
        : db
            .prepare(
              `INSERT INTO observations
								(kind, scope, project, session_id, title, content, topic_key, created_at, updated_at)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
							RETURNING id`,
            )
            .get(
              observation.kind,
              observation.scope,
              observation.project ?? null,
              observation.sessionId ?? null,
              observation.title,
              observation.content,
              null,
              now,
              now,
            );

      return { id: row ? String(row.id) : "" };
    } catch {
      return { id: "" };
    }
  }

  async forget(id: string): Promise<boolean> {
    try {
      const db = await this.open();
      if (!db) return false;
      const numeric = Number(id);
      if (!Number.isInteger(numeric)) return false;
      const result = db.prepare("DELETE FROM observations WHERE id = ?").run(numeric);
      return Number(result.changes) > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    this.opening = null;
    if (!db) return;
    try {
      db.close();
    } catch {
      // Already closed or unusable: nothing left to release.
    }
  }

  // Lazy and memoised: the constructor stays synchronous, and a missing
  // `node:sqlite` (Node < 22.5) only surfaces as a degraded provider.
  private async open(): Promise<SqliteDatabase | null> {
    if (this.db) return this.db;
    if (this.openFailed) return null;
    if (!this.opening) {
      this.opening = this.doOpen().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async doOpen(): Promise<SqliteDatabase | null> {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(this.dbPath) as unknown as SqliteDatabase;
      applyPragmas(db);
      migrate(db);
      this.db = db;
      return db;
    } catch {
      this.openFailed = true;
      return null;
    }
  }

  private toHit(row: Record<string, unknown>): MemoryHit {
    const rank = typeof row.rank === "number" ? row.rank : undefined;
    const hit: MemoryHit = {
      id: String(row.id),
      kind: asString(row.kind) as MemoryKind,
      scope: asString(row.scope) as MemoryScope,
      title: asString(row.title),
      content: truncate(asString(row.content), this.maxHitChars),
    };
    // bm25() is smaller for better matches; the interface only says "score".
    if (rank !== undefined) hit.score = rank;
    const createdAt = asNullableString(row.created_at);
    if (createdAt) hit.createdAt = createdAt;
    const project = asNullableString(row.project);
    if (project) hit.project = project;
    return hit;
  }
}
