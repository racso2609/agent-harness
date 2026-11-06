import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryProvider } from "../../src/memory";
import { HttpMemoryProvider } from "../../src/memory/HttpMemoryProvider";
import { NoopMemoryProvider } from "../../src/memory/NoopMemoryProvider";
import {
  buildContextUrl,
  buildUrl,
  fromEngramScope,
  fromEngramType,
  toEngramScope,
  toEngramType,
} from "../../src/memory/engram";
import type { MemoryKind, MemoryScope } from "../../src/memory/Memory";

// Everything here runs against an in-process `node:http` stub, so the suite
// does not need Engram installed. The stub plays back canned responses and
// records every request so the test can assert the exact path, query and body.

interface Recorded {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
  authorization: string | undefined;
}

interface Reply {
  status?: number;
  body?: unknown;
}

type Handler = (req: Recorded) => Reply;

let server: http.Server;
let baseUrl: string;
let requests: Recorded[];
let handler: Handler;
let provider: HttpMemoryProvider;

const startServer = async (custom: Handler): Promise<void> => {
  handler = custom;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://stub");
      const recorded: Recorded = {
        method: req.method ?? "GET",
        pathname: url.pathname,
        query: url.search,
        body: raw === "" ? undefined : JSON.parse(raw),
        authorization: req.headers.authorization,
      };
      requests.push(recorded);
      const reply = handler(recorded);
      const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
};

beforeEach(async () => {
  requests = [];
  await startServer(() => ({ status: 404, body: {} }));
  provider = new HttpMemoryProvider({ url: baseUrl, project: "proj" });
});

afterEach(async () => {
  await provider.close();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

describe("HttpMemoryProvider — the five calls", () => {
  it("reports the http id and its capabilities", () => {
    expect(provider.id).toBe("http");
    expect(provider.capabilities()).toEqual({
      search: true,
      context: true,
      capture: true,
      forget: true,
      // Engram searches with FTS5.
      semantic: false,
      scopes: ["user", "project", "session"],
    });
  });

  it("health() GETs /health", async () => {
    handler = () => ({ body: { status: "ok", service: "engram", version: "3.6.2" } });
    await expect(provider.health()).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.pathname).toBe("/health");
    expect(requests[0]?.query).toBe("");
    expect(requests[0]?.body).toBeUndefined();
  });

  it("health() reports a non-ok body instead of throwing", async () => {
    handler = () => ({ body: { status: "degraded" } });
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("degraded");
  });

  it("search() GETs /search with the exact query string and maps the hits", async () => {
    handler = () => ({
      body: {
        result: "ok",
        results: [
          {
            id: 42,
            title: "Deploys go through CI",
            type: "decision",
            scope: "project",
            preview: "we deploy with the pipeline",
            state: "active",
            review_after: null,
            sync_id: "abc",
            created_at: "2024-05-01T10:00:00.000Z",
          },
        ],
      },
    });

    const hits = await provider.search({ text: "deploy ci", limit: 5 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.pathname).toBe("/search");
    const query = new URLSearchParams(requests[0]?.query);
    expect(query.get("q")).toBe("deploy ci");
    expect(query.get("project")).toBe("proj");
    expect(query.get("response_format")).toBe("compact");
    expect(query.get("limit")).toBe("5");

    expect(hits).toEqual([
      {
        id: "42",
        kind: "decision",
        scope: "project",
        title: "Deploys go through CI",
        content: "we deploy with the pipeline",
        createdAt: "2024-05-01T10:00:00.000Z",
        project: "proj",
      },
    ]);
  });

  it("search() caps the preview at maxHitChars", async () => {
    handler = () => ({
      body: {
        results: [{ id: 1, title: "t", type: "fact", scope: "project", preview: "x".repeat(50) }],
      },
    });
    const capped = new HttpMemoryProvider({ url: baseUrl, maxHitChars: 10 });
    const hits = await capped.search({ text: "x" });
    expect(hits[0]?.content).toHaveLength(11);
    expect(hits[0]?.content.endsWith("…")).toBe(true);
  });

  it("context() GETs /context with compact and max_bytes", async () => {
    handler = () => ({ body: { context: "## Memoria del proyecto\n" } });
    const block = await provider.context({ maxChars: 2000 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.pathname).toBe("/context");
    const query = new URLSearchParams(requests[0]?.query);
    expect(query.get("project")).toBe("proj");
    expect(query.get("compact")).toBe("true");
    expect(query.get("max_bytes")).toBe("2000");
    expect(block).toBe("## Memoria del proyecto\n");
  });

  it("context() never returns more than maxChars", async () => {
    handler = () => ({ body: { context: "y".repeat(100) } });
    const block = await provider.context({ maxChars: 20 });
    expect(block.length).toBeLessThanOrEqual(20);
  });

  it("capture() POSTs /observations with the exact body", async () => {
    handler = () => ({ body: { id: 7, status: "saved" } });
    const result = await provider.capture({
      kind: "decision",
      scope: "project",
      title: "Deploys go through CI",
      content: "we deploy with the pipeline",
      project: "proj",
      sessionId: "s1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.pathname).toBe("/observations");
    expect(requests[0]?.query).toBe("");
    expect(requests[0]?.body).toEqual({
      session_id: "s1",
      type: "decision",
      title: "Deploys go through CI",
      content: "we deploy with the pipeline",
      project: "proj",
    });
    expect(result).toEqual({ id: "7" });
  });

  it("forget() DELETEs /observations/<id> with expected_project", async () => {
    handler = () => ({ body: { hard_delete: true, status: "deleted" } });
    const deleted = await provider.forget("42");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.pathname).toBe("/observations/42");
    const query = new URLSearchParams(requests[0]?.query);
    expect(query.get("expected_project")).toBe("proj");
    expect(deleted).toBe(true);
  });
});

describe("HttpMemoryProvider — forgetting and Engram's soft delete", () => {
  it("returns false when the backend only soft-deleted the observation", async () => {
    handler = () => ({ body: { hard_delete: false, status: "deleted" } });
    await expect(provider.forget("42")).resolves.toBe(false);
  });

  it("returns true when the observation was hard-deleted", async () => {
    handler = () => ({ body: { hard_delete: true, status: "deleted" } });
    await expect(provider.forget("42")).resolves.toBe(true);
  });

  it("returns true when the response omits hard_delete", async () => {
    handler = () => ({ body: { status: "deleted" } });
    await expect(provider.forget("42")).resolves.toBe(true);
  });

  it("returns false without a project, since Engram requires expected_project", async () => {
    const projectless = new HttpMemoryProvider({ url: baseUrl });
    await expect(projectless.forget("42")).resolves.toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("HttpMemoryProvider — a broken backend", () => {
  const broken: Record<string, Handler> = {
    500: () => ({ status: 500, body: { error: "boom" } }),
  };

  it("degrades every call to an empty value on HTTP 500", async () => {
    handler = broken[500] as Handler;
    await expect(provider.search({ text: "x" })).resolves.toEqual([]);
    await expect(provider.context({ maxChars: 100 })).resolves.toBe("");
    await expect(
      provider.capture({ kind: "fact", scope: "project", title: "t", content: "c" }),
    ).resolves.toEqual({ id: "" });
    await expect(provider.forget("1")).resolves.toBe(false);
    await expect(provider.health()).resolves.toEqual({ ok: false, detail: "HTTP 500" });
  });

  it("degrades every call when the server never answers", async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    // A stub that accepts the connection and never replies.
    server = http.createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const hanging = new HttpMemoryProvider({
      url: `http://127.0.0.1:${address.port}`,
      project: "proj",
      timeoutMs: 100,
    });

    await expect(hanging.search({ text: "x" })).resolves.toEqual([]);
    await expect(hanging.context({ maxChars: 100 })).resolves.toBe("");
    await expect(
      hanging.capture({ kind: "fact", scope: "project", title: "t", content: "c" }),
    ).resolves.toEqual({
      id: "",
    });
    await expect(hanging.forget("1")).resolves.toBe(false);
    await expect((await hanging.health()).ok).toBe(false);
  });

  it("degrades to an empty value when the connection is refused", async () => {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    const dead = new HttpMemoryProvider({
      url: `http://127.0.0.1:${port}`,
      project: "proj",
      timeoutMs: 500,
    });
    await expect(dead.search({ text: "x" })).resolves.toEqual([]);
    await expect((await dead.health()).ok).toBe(false);
    // Re-arm so afterEach has something to close.
    server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});

describe("HttpMemoryProvider — authentication", () => {
  it("sends the apikey as a Bearer token on every request", async () => {
    handler = (req) => {
      if (req.pathname === "/health") return { body: { status: "ok" } };
      if (req.pathname === "/search") return { body: { results: [] } };
      if (req.pathname === "/context") return { body: { context: "" } };
      if (req.pathname === "/observations" && req.method === "POST") return { body: { id: 1 } };
      return { body: { hard_delete: true } };
    };
    const authed = new HttpMemoryProvider({ url: baseUrl, apikey: "secret-key", project: "proj" });

    await authed.health();
    await authed.search({ text: "x" });
    await authed.context({ maxChars: 10 });
    await authed.capture({ kind: "fact", scope: "project", title: "t", content: "c" });
    await authed.forget("1");

    expect(requests).toHaveLength(5);
    for (const request of requests) expect(request.authorization).toBe("Bearer secret-key");
  });

  it("omits the Authorization header when no apikey is configured", async () => {
    handler = () => ({ body: { status: "ok" } });
    await provider.health();
    expect(requests[0]?.authorization).toBeUndefined();
  });
});

describe("engram mapping", () => {
  const kinds: MemoryKind[] = ["fact", "decision", "episode", "preference"];

  it("maps every kind to an Engram type and back", () => {
    const roundTrip: Record<MemoryKind, string> = {
      fact: "discovery",
      decision: "decision",
      episode: "learning",
      preference: "preference",
    };
    for (const kind of kinds) expect(toEngramType(kind)).toBe(roundTrip[kind]);
    // The reverse direction is lossy by design: several Engram types collapse
    // onto our `fact`, so they cannot be told apart once mapped.
    expect(fromEngramType("discovery")).toBe("fact");
    expect(fromEngramType("learning")).toBe("fact");
  });

  it("maps Engram-only types onto our kinds", () => {
    const table: Array<[string, MemoryKind]> = [
      ["decision", "decision"],
      ["bugfix", "fact"],
      ["discovery", "fact"],
      ["learning", "fact"],
      ["pattern", "decision"],
      ["architecture", "decision"],
      ["config", "preference"],
      ["preference", "preference"],
    ];
    for (const [type, kind] of table) expect(fromEngramType(type)).toBe(kind);
  });

  it("falls back to fact for an unknown type", () => {
    expect(fromEngramType("something-new")).toBe("fact");
  });

  it("maps scopes in both directions", () => {
    const table: Array<[MemoryScope, string, MemoryScope]> = [
      ["user", "personal", "user"],
      ["project", "project", "project"],
      ["session", "project", "project"],
    ];
    for (const [scope, engramScope, back] of table) {
      expect(toEngramScope(scope)).toBe(engramScope);
      expect(fromEngramScope(engramScope)).toBe(back);
    }
    expect(fromEngramScope("global")).toBe("user");
    expect(fromEngramScope("weird")).toBe("project");
  });

  it("builds URLs without empty parameters", () => {
    expect(buildUrl("http://h:1/", "/health")).toBe("http://h:1/health");
    expect(buildContextUrl("http://h:1", { project: undefined, maxBytes: 100 })).toBe(
      "http://h:1/context?compact=true&max_bytes=100",
    );
  });
});

describe("createMemoryProvider with the http provider", () => {
  it("resolves to HttpMemoryProvider when a url is configured", () => {
    const created = createMemoryProvider({
      enabled: true,
      provider: "http",
      url: "http://127.0.0.1:1",
    });
    expect(created).toBeInstanceOf(HttpMemoryProvider);
    expect(created.id).toBe("http");
  });

  it("degrades to NoopMemoryProvider without a url", () => {
    const created = createMemoryProvider({ enabled: true, provider: "http" });
    expect(created).toBeInstanceOf(NoopMemoryProvider);
  });

  it("degrades to NoopMemoryProvider when memory is disabled", () => {
    const created = createMemoryProvider({
      enabled: false,
      provider: "http",
      url: "http://127.0.0.1:1",
    });
    expect(created).toBeInstanceOf(NoopMemoryProvider);
  });
});
