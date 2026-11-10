import { describe, expect, it } from "vitest";
import { NoopMemoryProvider } from "@/memory";

describe("NoopMemoryProvider", () => {
  it("reports the none id", () => {
    expect(new NoopMemoryProvider().id).toBe("none");
  });

  it("declares no capabilities at all", () => {
    const provider = new NoopMemoryProvider();

    expect(provider.capabilities()).toEqual({
      search: false,
      context: false,
      capture: false,
      forget: false,
      semantic: false,
      scopes: [],
    });
  });

  it("is healthy: a no-op is not a failure", async () => {
    const provider = new NoopMemoryProvider();

    await expect(provider.health()).resolves.toEqual({ ok: true });
  });

  it("finds nothing", async () => {
    const provider = new NoopMemoryProvider();

    await expect(provider.search({ text: "anything" })).resolves.toEqual([]);
  });

  it("injects nothing", async () => {
    const provider = new NoopMemoryProvider();

    await expect(provider.context({ maxChars: 2000 })).resolves.toBe("");
  });

  it("captures nothing", async () => {
    const provider = new NoopMemoryProvider();

    await expect(
      provider.capture({ kind: "fact", scope: "project", title: "T", content: "C" }),
    ).resolves.toEqual({ id: "" });
  });

  it("forgets nothing", async () => {
    const provider = new NoopMemoryProvider();

    await expect(provider.forget("any")).resolves.toBe(false);
  });

  it("closes without throwing", async () => {
    const provider = new NoopMemoryProvider();

    await expect(provider.close()).resolves.toBeUndefined();
  });
});

describe("NoopMemoryProvider optional operations", () => {
  it("declares forget as unsupported", () => {
    expect(new NoopMemoryProvider().capabilities().forget).toBe(false);
  });

  it("does not implement inspect or recent, so a typeof check is safe", () => {
    const provider = new NoopMemoryProvider();

    expect(typeof provider.inspect).toBe("undefined");
    expect(typeof provider.recent).toBe("undefined");
  });
});
