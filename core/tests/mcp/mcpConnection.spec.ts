import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnection } from "../../src/mcp/McpConnection";
import type { ResolvedMcpServer } from "../../src/mcp/McpConfig";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "minimalServer.mjs",
);

// Every connection a test creates, closed in afterEach so the suite never
// leaves a server process behind.
const opened: McpConnection[] = [];

const makeServer = (args: string[] = []): ResolvedMcpServer => ({
  id: "fixture",
  transport: "stdio",
  command: process.execPath,
  args: [fixture, ...args],
  env: {},
  untrusted: false,
});

const connect = async (
  args: string[] = [],
  options: { startupTimeoutMs?: number; callTimeoutMs?: number } = {},
): Promise<McpConnection> => {
  const connection = new McpConnection(makeServer(args), {
    startupTimeoutMs: options.startupTimeoutMs ?? 5000,
    callTimeoutMs: options.callTimeoutMs ?? 2000,
  });
  opened.push(connection);

  return connection;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Polls until the process is gone, so a SIGTERM that lands late does not make
// the assertion flaky.
const waitForDeath = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return !isAlive(pid);
};

afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
});

describe("McpConnection handshake", () => {
  it("connects and lists the tools of the server", async () => {
    const connection = await connect();
    await connection.connect();

    expect(connection.status).toBe("ready");

    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail", "slow"]);

    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo?.description).toBe("Echoes back the given text");
    expect(echo?.annotations?.readOnlyHint).toBe(true);
    expect(echo?.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
    });

    const slow = tools.find((tool) => tool.name === "slow");
    expect(slow?.annotations?.destructiveHint).toBe(true);
  });

  it("follows the cursor through paginated tools/list", async () => {
    const connection = await connect(["--all-pages"]);
    await connection.connect();

    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail", "slow"]);
  });

  it("returns the text of a successful call", async () => {
    const connection = await connect();
    await connection.connect();

    const result = await connection.callTool("echo", { text: "hello harness" });
    expect(result).toEqual({ output: "hello harness", isError: false });
  });

  it("reports isError for a failing tool without throwing", async () => {
    const connection = await connect();
    await connection.connect();

    const result = await connection.callTool("fail", {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("tool failed on purpose");
  });
});

describe("McpConnection failures", () => {
  it("fails the handshake on timeout and kills the server", async () => {
    const connection = await connect(["--hang"], { startupTimeoutMs: 400 });

    const started = Date.now();
    await expect(connection.connect()).rejects.toThrow(/did not finish the handshake/);
    expect(Date.now() - started).toBeLessThan(3000);

    expect(connection.status).toBe("failed");
    expect(connection.lastError).toMatch(/did not finish the handshake/);

    const pid = connection.processId;
    expect(pid).toBeDefined();
    expect(await waitForDeath(pid as number)).toBe(true);
    expect(() => process.kill(pid as number, 0)).toThrow(/ESRCH/);
  });

  it("does not hang when the server exits before the handshake", async () => {
    const connection = await connect(["--exit-on-start"], { startupTimeoutMs: 3000 });

    await expect(connection.connect()).rejects.toThrow();
    expect(connection.status).toBe("failed");
  });

  it("marks the connection failed when the server dies, without hanging calls", async () => {
    const connection = await connect();
    await connection.connect();

    const pid = connection.processId as number;
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(connection.status).toBe("failed");
    expect(connection.lastError).toContain("exited");

    const result = await connection.callTool("echo", { text: "dead" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unavailable");
  });

  it("aborts a slow call and stays closable", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 10_000 });
    await connection.connect();

    const controller = new AbortController();
    const started = Date.now();
    const pending = connection.callTool("slow", {}, { signal: controller.signal });
    controller.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);

    const pid = connection.processId as number;
    await connection.close();
    expect(connection.status).toBe("closed");
    expect(await waitForDeath(pid)).toBe(true);
  });

  it("times out a call that never answers", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 300 });
    await connection.connect();

    const result = await connection.callTool("slow", {});
    expect(result.isError).toBe(true);
    expect(connection.status).toBe("ready");
  });
});

describe("McpConnection close", () => {
  it("is idempotent and leaves no process alive", async () => {
    const connection = await connect();
    await connection.connect();

    const pid = connection.processId as number;
    expect(isAlive(pid)).toBe(true);

    await connection.close();
    await connection.close();

    expect(connection.status).toBe("closed");
    expect(isAlive(pid)).toBe(false);
  });

  it("stops a fresh connection that never got to connect", async () => {
    const connection = await connect();
    await connection.close();

    expect(connection.status).toBe("closed");
    await expect(connection.connect()).rejects.toThrow(/cannot connect while closed/);
  });
});
