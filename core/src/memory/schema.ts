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
const TOPIC_KEY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS observations_topic_key
	ON observations(topic_key) WHERE topic_key IS NOT NULL`;

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

// Idempotent: safe to run on every open, which is what lets two processes share
// one file without a migration lock.
export const migrate = (db: SqliteDatabase) => {
  db.exec(OBSERVATIONS_TABLE);
  db.exec(TOPIC_KEY_INDEX);
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
