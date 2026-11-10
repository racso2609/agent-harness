import { logger } from "@/utils/logger";

// Minimal structural view of a `node:sqlite` DatabaseSync. The real type cannot
// be imported statically: `node:sqlite` does not exist on every Node version the
// package supports (engines: >=20.11), so LocalMemoryProvider loads it with a
// dynamic import and hands it over through this interface.
export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// Observations are the unit of memory: one row per fact, decision, episode or
// preference. `topic_key` is unique only when set, which turns "the login is
// fixed this way" into an upsert instead of a growing pile of duplicates.
const OBSERVATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS observations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	scope TEXT NOT NULL,
	project TEXT,
	session_id TEXT,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	topic_key TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	revision_count INTEGER NOT NULL DEFAULT 1
)`;

// Partial unique index: SQLite treats NULLs as distinct, but the WHERE clause
// makes the intent explicit and gives the upsert a named conflict target.
//
// The key is (project, topic_key), not topic_key alone: memory is per workspace,
// so a topicKey written from one project must never match - and therefore never
// overwrite or re-claim - a row written from another one. COALESCE keeps the
// rows whose project is NULL colliding with each other; a bare `project` column
// would make them all distinct, which is the opposite of what "no project" means
// here.
//
// The index name changed with the key on purpose: the legacy index is called
// `observations_topic_key`, and `CREATE ... IF NOT EXISTS` cannot replace an
// index that already exists under that name. A new name turns the migration into
// a one-time drop of the legacy index instead of an index rebuild on every open.
const TOPIC_KEY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS observations_project_topic_key
  ON observations(COALESCE(project, ''), topic_key) WHERE topic_key IS NOT NULL`;

// Name the older builds gave the global index. Kept only so the migration below
// can recognise and drop it.
const LEGACY_TOPIC_KEY_INDEX = "observations_topic_key";

const PROJECT_SCOPE_INDEX = `
CREATE INDEX IF NOT EXISTS observations_project_scope ON observations(project, scope)`;

const CREATED_AT_INDEX = `
CREATE INDEX IF NOT EXISTS observations_created_at ON observations(created_at)`;

// External-content FTS5 table: the text lives once, in observations, and the
// index keeps only the inverted terms.
const FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
	title,
	content,
	content='observations',
	content_rowid='id'
)`;

// The three triggers below are the standard external-content synchronisation
// pattern: the FTS index is never written by hand.
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
	INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
	INSERT INTO observations_fts(observations_fts, rowid, title, content)
		VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
	INSERT INTO observations_fts(observations_fts, rowid, title, content)
		VALUES ('delete', old.id, old.title, old.content);
	INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
`;

// Replaces the global unique index older builds created with the per-project
// one. A new index name is what makes this idempotent and cheap: the legacy
// index is looked up (and dropped) only while it is still there, and the new one
// is created with IF NOT EXISTS, so an already migrated file pays one
// sqlite_master lookup per open instead of a full index rebuild. Dropping an
// index loses no rows: it frees the index and nothing else.
//
// Two failures are swallowed on purpose, because memory has to keep working on a
// file we did not create:
// - the new index cannot be built because the file already holds duplicates of
// (project, topic_key). The rows are left untouched, the upsert is left without
// a conflict target, and LocalMemoryProvider.capture retries with a plain insert
// that keeps the `topic_key`: `remember` still stores, the write is only no
// longer a revision, and capture warns once about the degraded upsert.
// - the database is locked or read-only. The caller already degrades on a failed
//   open; this only decides how loud the report is.
const migrateTopicKeyIndex = (db: SqliteDatabase) => {
  try {
    const legacy = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(LEGACY_TOPIC_KEY_INDEX);
    if (legacy) db.exec(`DROP INDEX ${LEGACY_TOPIC_KEY_INDEX}`);
    db.exec(TOPIC_KEY_INDEX);
  } catch (error) {
    logger.warn(
      { err: error },
      "Memory topic key index migration failed; the topicKey upsert will degrade to a plain insert",
    );
  }
};

// Idempotent: safe to run on every open, which is what lets two processes share
// one file without a migration lock.
export const migrate = (db: SqliteDatabase) => {
  db.exec(OBSERVATIONS_TABLE);
  migrateTopicKeyIndex(db);
  db.exec(PROJECT_SCOPE_INDEX);
  db.exec(CREATED_AT_INDEX);
  db.exec(FTS_TABLE);
  db.exec(FTS_TRIGGERS);
};

// WAL lets a reader and a writer coexist (R4: two processes on one file).
// busy_timeout makes a locked write wait instead of failing immediately.
export const applyPragmas = (db: SqliteDatabase) => {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
};
