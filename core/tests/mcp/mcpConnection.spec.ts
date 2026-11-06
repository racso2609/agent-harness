import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/utils/logger";
import { McpConnection } from "../../src/mcp/McpConnection";
import type { ResolvedMcpServer } from "../../src/mcp/McpConfig";
import { findTagged, isOrphaned, listProcesses, type TaggedProcess } from "./processTable";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "minimalServer.mjs",
);

// Carried by every server this file spawns. The fixture hands the same value
// to each grandchild both as the `FIXTURE_TAG` environment variable and as the
// `fixture-grandchild:<tag>` process title, which is what makes a leaked one
// findable even after its parent exited and it was re-parented to init.
const FIXTURE_TAG = `mcp-connection-${process.pid}-${Date.now()}`;
const TAG_ENV_VAR = "FIXTURE_TAG";

// Every connection a test creates, closed in afterEach so the suite never
// leaves a server process behind.
const opened: McpConnection[] = [];

const makeServer = (args: string[] = [], env: Record<string, string> = {}): ResolvedMcpServer => ({
  id: "fixture",
  transport: "stdio",
  command: process.execPath,
  args: [fixture, ...args],
  env: { [TAG_ENV_VAR]: FIXTURE_TAG, ...env },
  untrusted: false,
});

const connect = async (
  args: string[] = [],
  options: { startupTimeoutMs?: number; callTimeoutMs?: number; env?: Record<string, string> } = {},
): Promise<McpConnection> => {
  const connection = new McpConnection(makeServer(args, options.env), {
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

// Direct children of a live pid, read from `ps` so it does not rely on the
// implementation under test.
const childrenOf = (pid: number): number[] => {
  const output = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([childPid, parentPid]) => parentPid === pid && childPid > 0)
    .map(([childPid]) => childPid);
};

// Temporary directory for fixtures that need to hand state back through a
// file (the pid of a grandchild of the server).
const scratchDirs: string[] = [];

const scratchDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "racso-mcp-"));
  scratchDirs.push(dir);
  return dir;
};

// The belt for what neither `close()` nor the fixture can clean up: a server
// killed with SIGKILL by a test never runs its own handlers, so the
// grandchild it spawned is re-parented to init and nothing else in the suite
// will ever reap it.
//
// The sweep only ever kills orphans. A tagged process that still has its
// parent was not abandoned by it, and killing it here would SIGKILL a server
// in the middle of its own `stopChildren()`, which is exactly the layer that
// takes the grandchild down.
//
// Returns what it found, and both lists are failures: a survivor is a real
// leak, and a tagged process that is still parented to something means a
// connection was never closed.
const sweepTagged = (): { swept: TaggedProcess[]; parented: TaggedProcess[] } => {
  const rows = listProcesses();
  const tagged = findTagged(rows, FIXTURE_TAG);
  const swept: TaggedProcess[] = [];
  const parented: TaggedProcess[] = [];

  for (const process_ of tagged) {
    if (!isOrphaned(process_.pid, process_.ppid, rows)) {
      parented.push(process_);
      continue;
    }

    try {
      process.kill(process_.pid, "SIGKILL");
    } catch {
      // Already gone.
    }

    swept.push(process_);
  }

  return { swept, parented };
};

// Why the suite lets a leaked process fail the file instead of only sweeping
// it: `expect` inside `afterEach` fails the run and does not swallow the
// failure of the test that leaked it.
afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });

  const { swept, parented } = sweepTagged();
  const describe_ = (found: TaggedProcess[]): string =>
    found.map((process_) => `${process_.pid} (ppid ${process_.ppid})`).join(", ");

  expect(
    swept,
    `processes tagged ${FIXTURE_TAG} outlived their server and had to be swept: ${describe_(swept)}`,
  ).toEqual([]);
  expect(
    parented,
    `processes tagged ${FIXTURE_TAG} were still running under a live parent after close(): ${describe_(parented)}`,
  ).toEqual([]);
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

describe("McpConnection aborts", () => {
  it("answers an already aborted call without touching the connection", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 10_000 });
    await connection.connect();

    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    const result = await connection.callTool("slow", {}, { signal: controller.signal });

    expect(result).toEqual({ output: 'Tool "slow" was cancelled', isError: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(connection.status).toBe("ready");
    expect(connection.lastError).toBeUndefined();
  });

  it("answers an aborted call in flight without waiting for the call timeout", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 10_000 });
    await connection.connect();

    const controller = new AbortController();
    const started = Date.now();
    const pending = connection.callTool("slow", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    const result = await pending;

    expect(result).toEqual({ output: 'Tool "slow" was cancelled', isError: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connection.status).toBe("ready");
  });

  it("does not wait for the call timeout when a server ignores the cancellation", async () => {
    // The server drops cancellations, so the SDK handler only goes away when
    // the transport closes. That must not turn into a stuck call.
    const connection = await connect(["--slow-call", "--abort-proof"], {
      callTimeoutMs: 300,
    });
    await connection.connect();

    const controller = new AbortController();
    const started = Date.now();
    const pending = connection.callTool("slow", {}, { signal: controller.signal });
    controller.abort();

    const result = await pending;

    expect(result.output).toBe('Tool "slow" was cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(connection.status).toBe("ready");
  });

  it("keeps the server usable after an abort", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 10_000 });
    await connection.connect();

    // Aborted while the call is on the wire, which is what has to leave the
    // server usable.
    const controller = new AbortController();
    const pending = connection.callTool("slow", {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect((await pending).isError).toBe(true);

    // The process is still there, so the next call must work: the connection
    // stays `ready` and never becomes a lie.
    expect(connection.status).toBe("ready");
    const pid = connection.processId as number;
    expect(isAlive(pid)).toBe(true);

    const after = await connection.callTool("echo", { text: "still here" });
    expect(after).toEqual({ output: "still here", isError: false });
  });
});

describe("McpConnection environment", () => {
  it("passes only the declared env plus the SDK whitelist to the server", async () => {
    // A variable the test owns: if the child inherited process.env, it would
    // be visible to the server.
    process.env.RACSO_TEST_SECRET = "do-not-leak";
    const previousPath = process.env.PATH;

    try {
      const connection = await connect([], { env: { MY_VAR: "x" } });
      await connection.connect();

      const result = await connection.callTool("env", {});
      expect(result.isError).toBe(false);

      const names = result.output.split(",");
      expect(names).toContain("MY_VAR");
      expect(names).not.toContain("RACSO_TEST_SECRET");
      // The SDK whitelist is what the server is supposed to see, so PATH (set
      // for this process) must be there even though the config never asked.
      if (previousPath !== undefined) expect(names).toContain("PATH");
      expect(names).not.toContain("OMNIROUTE_API_KEY");
    } finally {
      delete process.env.RACSO_TEST_SECRET;
      if (previousPath === undefined) delete process.env.PATH;
    }
  });
});

describe("McpConnection failure paths", () => {
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

describe("McpConnection process tree", () => {
  it("kills the grandchildren of the server on close", async () => {
    const dir = scratchDir();
    const pidFile = path.join(dir, "grandchild.pid");

    const connection = await connect(["--grandchild"], {
      env: { GRANDCHILD_PID_FILE: pidFile },
    });
    await connection.connect();

    const serverPid = connection.processId as number;
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(grandchild).toBeGreaterThan(0);
    expect(childrenOf(serverPid)).toContain(grandchild);
    expect(isAlive(grandchild)).toBe(true);

    await connection.close();

    expect(await waitForDeath(serverPid)).toBe(true);
    expect(await waitForDeath(grandchild)).toBe(true);
  });

  // Documented limit, not a bug to be fixed here. A server killed with SIGKILL
  // never runs `process.on("exit")`, so the grandchild it spawned is
  // re-parented to init while it is still alive. Nothing in this process can
  // bring it down: `close()` walks the tree of a pid that no longer exists, and
  // following the orphan would mean a supervisor of its own around every
  // server. What the suite guarantees instead, and what this test pins, is
  // that the leak is never silent: the `afterEach` sweep finds the orphan,
  // reports it, and fails the file. That sweep runs right after this test.
  it("leaves no grandchild behind when the server is SIGKILLed", async () => {
    const dir = scratchDir();
    const pidFile = path.join(dir, "grandchild.pid");

    const connection = await connect(["--grandchild"], {
      env: { GRANDCHILD_PID_FILE: pidFile },
    });
    await connection.connect();

    const serverPid = connection.processId as number;
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(await waitForDeath(grandchild, 0)).toBe(false);

    // The same kill a crashed or OOM-killed server gets: no handler of its own
    // ever runs, which is the whole point.
    process.kill(serverPid, "SIGKILL");
    expect(await waitForDeath(serverPid)).toBe(true);

    // The system does not clean this up: the grandchild is still running, and
    // the sweep sees it as an orphan it would have to reap.
    expect(await waitForDeath(grandchild, 250)).toBe(false);
    const rows = listProcesses();
    const orphan = findTagged(rows, FIXTURE_TAG).find((process_) => process_.pid === grandchild);
    expect(orphan).toBeDefined();
    expect(isOrphaned(orphan!.pid, orphan!.ppid, rows)).toBe(true);

    // Reaped here only so this test can assert the sweep's finding without
    // failing the file it runs in. `sweepTagged` above does exactly this, and
    // the deliberate-leak check in the report relies on it.
    process.kill(grandchild, "SIGKILL");
    expect(await waitForDeath(grandchild)).toBe(true);
  });

  it("kills the grandchildren of a server that never finished the handshake", async () => {
    const dir = scratchDir();
    const pidFile = path.join(dir, "grandchild.pid");

    const connection = await connect(["--grandchild", "--hang"], {
      startupTimeoutMs: 400,
      env: { GRANDCHILD_PID_FILE: pidFile },
    });

    await expect(connection.connect()).rejects.toThrow(/did not finish the handshake/);

    const serverPid = connection.processId as number;
    const grandchild = Number(readFileSync(pidFile, "utf8"));

    expect(await waitForDeath(serverPid)).toBe(true);
    expect(await waitForDeath(grandchild)).toBe(true);
  });
});

describe("McpConnection close after a failure", () => {
  it("releases calls still in flight instead of waiting for the call timeout", async () => {
    const connection = await connect(["--hang", "--slow-call"], {
      startupTimeoutMs: 300,
      callTimeoutMs: 10_000,
    });

    // `connect` rejects on the handshake timeout while the server keeps
    // running, which is exactly the `failed` state that used to leak calls.
    // `connect` owns the kill, so close() racing it is not what is tested.
    await expect(connection.connect()).rejects.toThrow(/did not finish the handshake/);
    expect(connection.status).toBe("failed");

    const started = Date.now();
    await connection.close();

    expect(connection.status).toBe("closed");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("closes a failed connection without hanging when a call is in flight", async () => {
    const connection = await connect(["--slow-call"], { callTimeoutMs: 10_000 });
    await connection.connect();

    const pending = connection.callTool("slow", {});
    const started = Date.now();
    await connection.close();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("McpConnection concurrency", () => {
  it("rejects a second connect while the first is starting", async () => {
    const connection = await connect();
    const first = connection.connect();

    await expect(connection.connect()).rejects.toThrow(/cannot connect while starting/);

    await first;
    expect(connection.status).toBe("ready");

    const result = await connection.callTool("echo", { text: "one" });
    expect(result).toEqual({ output: "one", isError: false });

    // Exactly one server exists: the second connect failed before spawning,
    // and the connection has a single pid.
    expect(childrenOf(process.pid).filter((pid) => pid === connection.processId)).toHaveLength(1);
  });
});

describe("McpConnection listTools", () => {
  it("stops at the page cap and warns instead of dropping tools silently", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(logger, "warn").mockImplementation((message: string) => {
      warnings.push(message);
    });

    try {
      const connection = await connect(["--endless-pages"]);
      await connection.connect();

      const tools = await connection.listTools();

      expect(tools).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/still had tools after 50 pages/);
      expect(connection.status).toBe("ready");
    } finally {
      spy.mockRestore();
    }
  });

  it("de-duplicates a tool name repeated across pages, keeping the first", async () => {
    const connection = await connect(["--codex-pages"]);
    await connection.connect();

    const tools = await connection.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
    // The first definition wins, not the one from the later page.
    expect(tools[0].description).toBe("Echoes back the given text");
  });
});
