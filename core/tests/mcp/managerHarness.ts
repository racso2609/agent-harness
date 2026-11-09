import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { McpConfig, ResolvedMcpServer } from "../../src/mcp/McpConfig";
import { McpConnection, type McpConnectionOptions } from "../../src/mcp/McpConnection";
import { McpManager, type McpManagerOptions } from "../../src/mcp/McpManager";
import { listProcesses, sweepOrphans, type TaggedProcess } from "./processTable";

export const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "minimalServer.mjs",
);

// Carried by every server a test spawns, so a leaked one is findable even after
// it was re-parented to init. One tag per test file keeps the sweeps of two
// files from seeing each other's processes.
export const makeTag = (name: string): string => `${name}-${process.pid}-${Date.now()}`;

export interface ServerSpec {
  args?: string[];
  env?: Record<string, string>;
  untrusted?: boolean;
}

// Builds the `mcp` block of a config with the fixture as the server command.
export const makeMcpConfig = (
  tag: string,
  servers: Record<string, ServerSpec>,
  overrides: Partial<McpConfig> = {},
): McpConfig => ({
  enabled: true,
  maxDescriptionChars: 300,
  startupTimeoutMs: 5000,
  callTimeoutMs: 2000,
  servers: Object.fromEntries(
    Object.entries(servers).map(([id, spec]) => [
      id,
      {
        command: process.execPath,
        args: [fixture, ...(spec.args ?? [])],
        env: { FIXTURE_TAG: tag, ...spec.env },
        ...(spec.untrusted ? { untrusted: true } : {}),
      },
    ]),
  ),
  ...overrides,
});

// A manager over the fixture, with every connection it opens recorded so a test
// can count them, watch their methods and read their pid.
export const makeManager = (
  tag: string,
  servers: Record<string, ServerSpec>,
  options: { config?: Partial<McpConfig>; manager?: McpManagerOptions } = {},
) => {
  const connections: McpConnection[] = [];
  const createConnection = vi.fn((server: ResolvedMcpServer, connOptions: McpConnectionOptions) => {
    const connection = new McpConnection(server, connOptions);
    connections.push(connection);
    return connection;
  });

  const manager = new McpManager(
    { mcp: makeMcpConfig(tag, servers, options.config) },
    { ...options.manager, createConnection },
  );

  return { manager, connections, createConnection };
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Polls until the process is gone, so a SIGTERM that lands late does not make
// the assertion flaky.
export const waitForDeath = async (pid: number, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return !isAlive(pid);
};

// Every process still carrying the tag of a test, whether it is an orphan or
// still parented to a live server.
export const tagged = (tag: string): TaggedProcess[] => {
  const { orphans, parented } = sweepOrphans(listProcesses(), tag);
  return [...orphans, ...parented];
};
