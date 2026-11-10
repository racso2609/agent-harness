import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryProvider,
  DEFAULT_MAX_HIT_CHARS,
  LocalMemoryProvider,
  NoopMemoryProvider,
} from "../../src/memory";
import { toFtsQuery } from "../../src/memory/LocalMemoryProvider";
import { logger } from "../../src/utils/logger";
import type { MemoryObservation } from "../../src/memory/Memory";

let dir: string;
let dbPath: string;
let provider: LocalMemoryProvider;

const makeProvider = (file: string = dbPath) => new LocalMemoryProvider({ path: file });

const observation = (overrides: Partial<MemoryObservation> = {}): MemoryObservation => ({
  kind: "fact",
  scope: "project",
  title: "Observation",
  content: "content",
  ...overrides,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-"));
  dbPath = path.join(dir, "memory.db");
  provider = makeProvider();
});

afterEach(async () => {
  await provider.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("LocalMemoryProvider", () => {
  it("reports the local id and its capabilities", () => {
    expect(provider.id).toBe("local");
    expect(provider.capabilities()).toEqual({
      search: true,
      context: true,
      capture: true,
      forget: true,
      semantic: false,
      scopes: ["user", "project", "session"],
    });
  });

  it("is healthy on a fresh file", async () => {
    await expect(provider.health()).resolves.toEqual({ ok: true });
  });

  it("captures observations and finds only the matching one", async () => {
    await provider.capture(
      observation({
        title: "Deploy pipeline",
        content: "CI runs the deploy through GitHub Actions.",
      }),
    );
    await provider.capture(
      observation({
        title: "Auth decision",
        content: "The login uses a signed cookie, not a JWT.",
      }),
    );
    await provider.capture(
      observation({
        title: "Editor preference",
        content: "The user prefers tabs over spaces.",
      }),
    );

    const hits = await provider.search({ text: "cookie" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Auth decision");
    expect(hits[0]?.content).toContain("signed cookie");
  });

  it("returns [] for a term that is not stored", async () => {
    await provider.capture(
      observation({ title: "Deploy pipeline", content: "CI runs the deploy." }),
    );

    await expect(provider.search({ text: "kubernetes" })).resolves.toEqual([]);
  });

  it("lets a second instance on the same file read what the first wrote", async () => {
    await provider.capture(
      observation({
        title: "Shared fact",
        content: "The staging host is neon.",
      }),
    );

    const second = makeProvider();
    try {
      const hits = await second.search({ text: "neon" });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.title).toBe("Shared fact");
    } finally {
      await second.close();
    }
  });

  it("upserts on topicKey, keeping one row with revision_count 2 and the same id", async () => {
    const first = await provider.capture(
      observation({
        title: "How login is fixed",
        content: "The login was broken by a stale cookie.",
        topicKey: "auth.login.fix",
      }),
    );
    const second = await provider.capture(
      observation({
        title: "How login is fixed",
        content: "The login was fixed by clearing the cookie jar.",
        topicKey: "auth.login.fix",
      }),
    );

    expect(first.id).not.toBe("");
    expect(second.id).toBe(first.id);

    // The old revision is replaced, not accumulated.
    const stale = await provider.search({ text: "stale" });
    expect(stale).toHaveLength(0);
    const updated = await provider.search({ text: "cookie" });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe(first.id);
    expect(updated[0]?.content).toContain("cookie jar");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath) as unknown as {
      prepare(sql: string): {
        all(...params: unknown[]): Record<string, unknown>[];
      };
      close(): void;
    };
    try {
      const rows = db
        .prepare("SELECT id, revision_count FROM observations WHERE topic_key = ?")
        .all("auth.login.fix");
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.revision_count)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("keeps the same topicKey in two projects as two rows, neither re-claimed", async () => {
    const inA = await provider.capture(
      observation({
        title: "A key",
        content: "The key lives in A.",
        topicKey: "secret.key",
        project: "A",
      }),
    );
    const inB = await provider.capture(
      observation({
        title: "B key",
        content: "The key lives in B.",
        topicKey: "secret.key",
        project: "B",
      }),
    );

    // Same key, different workspace: a second row, not a revision of the first.
    expect(inA.id).not.toBe("");
    expect(inB.id).not.toBe(inA.id);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath) as unknown as {
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
    try {
      const rows = db
        .prepare(
          "SELECT id, project, title, revision_count FROM observations WHERE topic_key = ? ORDER BY id",
        )
        .all("secret.key");

      expect(rows).toHaveLength(2);
      // The second write did not steal the first row's project.
      expect(rows.map((row) => row.project)).toEqual(["A", "B"]);
      expect(rows.map((row) => Number(row.revision_count))).toEqual([1, 1]);
      expect(rows.map((row) => String(row.id))).toEqual([inA.id, inB.id]);
    } finally {
      db.close();
    }
  });

  it("still upserts when the same topicKey repeats inside one project", async () => {
    const first = await provider.capture(
      observation({
        title: "Deploy host",
        content: "The deploy runs on neon.",
        topicKey: "deploy.host",
        project: "A",
      }),
    );
    const second = await provider.capture(
      observation({
        title: "Deploy host",
        content: "The deploy runs on argon.",
        topicKey: "deploy.host",
        project: "A",
      }),
    );

    expect(second.id).toBe(first.id);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath) as unknown as {
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
    try {
      const rows = db
        .prepare("SELECT project, revision_count FROM observations WHERE topic_key = ?")
        .all("deploy.host");

      expect(rows).toHaveLength(1);
      expect(rows[0]?.project).toBe("A");
      expect(Number(rows[0]?.revision_count)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("migrates a database that still has the global topicKey index", async () => {
    // The state older builds left behind: the unique index on topic_key alone.
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(dbPath) as unknown as {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): unknown;
        all(...params: unknown[]): Record<string, unknown>[];
      };
      close(): void;
    };
    try {
      legacy.exec(`
CREATE TABLE observations (
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
)`);
      legacy.exec(`
CREATE UNIQUE INDEX observations_topic_key
ON observations(topic_key) WHERE topic_key IS NOT NULL`);
      const insert = legacy.prepare(
        "INSERT INTO observations (kind, scope, project, title, content, topic_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "fact",
        "project",
        "A",
        "Kept",
        "An old row.",
        "old.key",
        "2024-01-01",
        "2024-01-01",
      );
      insert.run(
        "fact",
        "project",
        "B",
        "Kept too",
        "Another old row.",
        null,
        "2024-01-01",
        "2024-01-01",
      );
    } finally {
      legacy.close();
    }

    // Opening the provider is what runs the migration.
    await expect(provider.health()).resolves.toEqual({ ok: true });

    const db = new DatabaseSync(dbPath) as unknown as {
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
    try {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
      const names = indexes.map((row) => String(row.name));

      expect(names).toContain("observations_project_topic_key");
      expect(names).not.toContain("observations_topic_key");
      // No row is lost by dropping the index.
      const rows = db.prepare("SELECT project, title FROM observations ORDER BY id").all();
      expect(rows.map((row) => row.title)).toEqual(["Kept", "Kept too"]);
    } finally {
      db.close();
    }

    // The migrated index is the per-project one: the same key from another
    // project is a second row instead of a revision of the first.
    const other = await provider.capture(
      observation({ title: "New", content: "A new row.", topicKey: "old.key", project: "B" }),
    );
    expect(other.id).not.toBe("");

    const migrated = new DatabaseSync(dbPath) as unknown as {
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
    try {
      const rows = migrated
        .prepare("SELECT project, topic_key FROM observations WHERE topic_key = ? ORDER BY id")
        .all("old.key");

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.project)).toEqual(["A", "B"]);
    } finally {
      migrated.close();
    }
  });
  it("forgets an existing id and reports a missing one as false", async () => {
    const { id } = await provider.capture(
      observation({ title: "Ephemeral", content: "The scratch token is 42." }),
    );

    await expect(provider.forget(id)).resolves.toBe(true);
    await expect(provider.search({ text: "scratch" })).resolves.toEqual([]);

    await expect(provider.forget(id)).resolves.toBe(false);
    await expect(provider.forget("does-not-exist")).resolves.toBe(false);
  });

  it("honours maxChars in context", async () => {
    for (let i = 0; i < 5; i += 1) {
      await provider.capture(
        observation({
          title: `Fact ${i}`,
          content: `A fairly long observation body number ${i} with enough words to matter.`,
        }),
      );
    }

    const block = await provider.context({ maxChars: 200 });

    expect(typeof block).toBe("string");
    expect(block.length).toBeLessThanOrEqual(200);
    expect(block.length).toBeGreaterThan(0);
  });

  it("returns an empty context when maxChars is 0", async () => {
    await provider.capture(observation({ title: "Fact", content: "Something to inject." }));

    await expect(provider.context({ maxChars: 0 })).resolves.toBe("");
  });

  it("does not throw on FTS5 syntax in the query text", async () => {
    await provider.capture(
      observation({
        title: "Login bug",
        content: "The login (bug) comes from a race.",
      }),
    );

    const queries = ['"login (bug)"', "foo AND bar", "a* b", "NEAR(a b)", "---", "OR", "NOT"];

    for (const text of queries) {
      const result = await provider.search({ text });
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it("turns raw text into a safe OR-joined MATCH expression", () => {
    expect(toFtsQuery('"login (bug)"')).toBe('"login" OR "bug"');
    expect(toFtsQuery("foo AND bar")).toBe('"foo" OR "and" OR "bar"');
    expect(toFtsQuery("a* b")).toBe('"a" OR "b"');
    expect(toFtsQuery("NEAR(a b)")).toBe('"near" OR "a" OR "b"');
    expect(toFtsQuery("---")).toBe("");
    expect(toFtsQuery("")).toBe("");
  });

  it("keeps multibyte context valid and within the character budget", async () => {
    await provider.capture(
      observation({
        title: "Emojis y acentos",
        content: "Despliegue 🚀 con acentos: ñandú, acción, pingüino 🎉 y más texto de relleno.",
      }),
    );
    await provider.capture(
      observation({
        title: "Otra observación 🧠",
        content: "Memoria local con SQLite ✅ y FTS5, más relleno para forzar el recorte ✂️.",
      }),
    );

    const block = await provider.context({ maxChars: 80 });

    expect(block.length).toBeLessThanOrEqual(80);
    expect(Buffer.from(block, "utf8").toString("utf8")).toBe(block);
  });

  it("truncates hit content to maxHitChars", async () => {
    const capped = new LocalMemoryProvider({ path: dbPath, maxHitChars: 10 });
    try {
      await capped.capture(observation({ title: "Long", content: "abcdefghijklmnopqrstuvwxyz" }));

      const hits = await capped.search({ text: "abcdefghijklmnopqrstuvwxyz" });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.content.length).toBeLessThanOrEqual(11);
      expect(DEFAULT_MAX_HIT_CHARS).toBe(1200);
    } finally {
      await capped.close();
    }
  });

  it("inspects an existing observation by id", async () => {
    const { id } = await provider.capture(
      observation({
        kind: "decision",
        title: "Use sqlite",
        content: "We chose node:sqlite for the local store.",
        topicKey: "store.engine",
        project: "demo",
      }),
    );

    const found = await provider.inspect(id);

    expect(found).toMatchObject({
      kind: "decision",
      scope: "project",
      title: "Use sqlite",
      content: "We chose node:sqlite for the local store.",
      project: "demo",
      topicKey: "store.engine",
    });
  });

  it("inspects nothing for an unknown or non-numeric id", async () => {
    const { id } = await provider.capture(observation({ title: "T", content: "C" }));

    await expect(provider.inspect(String(Number(id) + 1000))).resolves.toBeUndefined();
    await expect(provider.inspect("does-not-exist")).resolves.toBeUndefined();
    await expect(provider.inspect("")).resolves.toBeUndefined();
  });

  it("returns the recent observations newest first", async () => {
    for (const title of ["first", "second", "third"]) {
      await provider.capture(observation({ title, content: `${title} body` }));
    }

    const hits = await provider.recent({});

    expect(hits.map((hit) => hit.title)).toEqual(["third", "second", "first"]);
  });

  it("honours the limit passed to recent", async () => {
    for (const title of ["first", "second", "third"]) {
      await provider.capture(observation({ title, content: `${title} body` }));
    }

    const hits = await provider.recent({ limit: 2 });

    expect(hits.map((hit) => hit.title)).toEqual(["third", "second"]);
  });

  it("falls back to a default limit when recent gets none", async () => {
    // More rows than the documented default, so the fallback is observable.
    for (let i = 0; i < 25; i += 1) {
      await provider.capture(observation({ title: `entry ${i}`, content: `body ${i}` }));
    }

    const all = await provider.recent({});
    const capped = await provider.recent({ limit: 5 });

    expect(all).toHaveLength(20);
    expect(capped).toHaveLength(5);
    expect(all[0]?.title).toBe("entry 24");
  });

  it("stores with a plain insert when the topicKey index could not be built", async () => {
    // The state the migration refuses to fix: two rows already share
    // (project, topic_key), so the unique index cannot be created and the file the
    // provider opens has no conflict target at all.
    const { DatabaseSync } = await import("node:sqlite");
    const seeded = new DatabaseSync(dbPath) as unknown as {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    try {
      seeded.exec(`
CREATE TABLE observations (
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
)`);
      const insert = seeded.prepare(
        "INSERT INTO observations (kind, scope, project, title, content, topic_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "fact",
        "project",
        "A",
        "First",
        "A duplicate.",
        "dup.key",
        "2024-01-01",
        "2024-01-01",
      );
      insert.run(
        "fact",
        "project",
        "A",
        "Second",
        "The other duplicate.",
        "dup.key",
        "2024-01-01",
        "2024-01-01",
      );
    } finally {
      seeded.close();
    }

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // Opening runs the migration, which fails on the duplicates and leaves the
      // index out; the write then has no conflict target to upsert against.
      const { id } = await provider.capture(
        observation({ title: "Deploy host", content: "It runs on neon.", topicKey: "deploy.host" }),
      );

      // The write is stored, not reported as failed: the fallback keeps the row.
      expect(id).not.toBe("");

      const db = new DatabaseSync(dbPath) as unknown as {
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
        close(): void;
      };
      try {
        const rows = db
          .prepare("SELECT project, topic_key, title FROM observations WHERE topic_key = ?")
          .all("deploy.host");

        expect(rows).toHaveLength(1);
        expect(rows[0]?.title).toBe("Deploy host");
        // Retrying must not move the row out of the workspace it was written in.
        expect(rows[0]?.project).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once about the degraded upsert, not on every write", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const seeded = new DatabaseSync(dbPath) as unknown as {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    try {
      seeded.exec(`
CREATE TABLE observations (
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
)`);
      const insert = seeded.prepare(
        "INSERT INTO observations (kind, scope, project, title, content, topic_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "fact",
        "project",
        "A",
        "First",
        "A duplicate.",
        "dup.key",
        "2024-01-01",
        "2024-01-01",
      );
      insert.run(
        "fact",
        "project",
        "A",
        "Second",
        "The other duplicate.",
        "dup.key",
        "2024-01-01",
        "2024-01-01",
      );
    } finally {
      seeded.close();
    }

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const degradedWarnings = () =>
        warn.mock.calls.filter(([, message]) =>
          String(message).includes("stored with a plain insert"),
        ).length;

      const first = await provider.capture(
        observation({ title: "One", content: "First degraded write.", topicKey: "one.key" }),
      );
      expect(first.id).not.toBe("");
      expect(degradedWarnings()).toBe(1);

      await provider.capture(
        observation({ title: "Two", content: "Second degraded write.", topicKey: "two.key" }),
      );
      expect(degradedWarnings()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("degrades instead of throwing when the path is unusable", async () => {
    const broken = new LocalMemoryProvider({
      path: "/ruta/que/no/existe/x.db",
    });
    try {
      await expect(broken.health()).resolves.toMatchObject({ ok: false });
      await expect(broken.search({ text: "anything" })).resolves.toEqual([]);
      await expect(broken.context({ maxChars: 200 })).resolves.toBe("");
      await expect(broken.capture(observation({ title: "T", content: "C" }))).resolves.toEqual({
        id: "",
      });
      await expect(broken.forget("1")).resolves.toBe(false);
    } finally {
      await broken.close();
    }
  });
});

describe("createMemoryProvider", () => {
  it("returns the noop provider when memory is disabled", () => {
    expect(
      createMemoryProvider({ enabled: false, provider: "local", path: dbPath }),
    ).toBeInstanceOf(NoopMemoryProvider);
  });

  it("returns the local provider when configured", () => {
    expect(createMemoryProvider({ enabled: true, provider: "local", path: dbPath })).toBeInstanceOf(
      LocalMemoryProvider,
    );
  });

  it("falls back to noop for the not-yet-implemented http and mcp backends", () => {
    expect(createMemoryProvider({ enabled: true, provider: "http" })).toBeInstanceOf(
      NoopMemoryProvider,
    );
    expect(createMemoryProvider({ enabled: true, provider: "mcp" })).toBeInstanceOf(
      NoopMemoryProvider,
    );
  });

  it("falls back to noop when no config is given", () => {
    expect(createMemoryProvider(undefined)).toBeInstanceOf(NoopMemoryProvider);
  });
});
