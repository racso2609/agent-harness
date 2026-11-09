import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryProvider,
  DEFAULT_MAX_HIT_CHARS,
  LocalMemoryProvider,
  NoopMemoryProvider,
} from "../../src/memory";
import { toFtsQuery } from "../../src/memory/LocalMemoryProvider";
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
