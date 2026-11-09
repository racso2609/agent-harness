import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();

vi.mock("../../src/utils/logger", () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const { resolveMcpServers } = await import("../../src/mcp/McpConfig");
import type { HarnessConfig } from "../../src/configuration";

const buildConfig = (mcp: HarnessConfig["mcp"]): HarnessConfig => ({ providers: {}, mcp });

const tempDirs: string[] = [];

beforeEach(() => {
  warn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Loads a fresh Config from a temp config file so module state stays clean.
const loadConfig = async (contents: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-mcp-config-"));
  const location = path.join(dir, "config.json");
  tempDirs.push(dir);
  fs.writeFileSync(location, JSON.stringify(contents), "utf8");
  vi.stubEnv("RACSO_HARNESS_CONFIG_LOCATION", location);
  vi.resetModules();

  const { Config } = await import("../../src/configuration");
  return new Config();
};

describe("resolveMcpServers", () => {
  it("resolves nothing when the mcp block is absent", () => {
    const config = buildConfig(undefined);

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves nothing when the master switch is off", () => {
    const config = buildConfig({
      enabled: false,
      servers: { github: { command: "npx", args: ["mcp-github"] } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves an empty list when enabled without servers", () => {
    const config = buildConfig({ enabled: true, servers: {} });

    expect(resolveMcpServers(config)).toEqual([]);
  });

  it("applies the defaults to a minimal server", () => {
    const config = buildConfig({
      enabled: true,
      servers: { github: { command: "npx" } },
    });

    expect(resolveMcpServers(config)).toEqual([
      {
        id: "github",
        transport: "stdio",
        command: "npx",
        args: [],
        env: {},
        untrusted: false,
      },
    ]);
  });

  it("keeps the full definition when every field is set", () => {
    const config = buildConfig({
      enabled: true,
      servers: {
        files: {
          transport: "stdio",
          command: "mcp-files",
          args: ["--root", "/tmp"],
          env: { TOKEN: "secret" },
          cwd: "/tmp",
          untrusted: true,
          description: "Local files",
        },
      },
    });

    expect(resolveMcpServers(config)).toEqual([
      {
        id: "files",
        transport: "stdio",
        command: "mcp-files",
        args: ["--root", "/tmp"],
        env: { TOKEN: "secret" },
        cwd: "/tmp",
        untrusted: true,
        description: "Local files",
      },
    ]);
  });

  it("skips a server without a command and warns", () => {
    const config = buildConfig({
      enabled: true,
      servers: {
        broken: {} as never,
        ok: { command: "mcp-ok" },
      },
    });

    expect(resolveMcpServers(config).map((server) => server.id)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("missing a command");
  });

  it("skips a server with a blank command", () => {
    const config = buildConfig({ enabled: true, servers: { blank: { command: "   " } } });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips a server with an unsupported transport", () => {
    const config = buildConfig({
      enabled: true,
      servers: { web: { transport: "http" as never, command: "mcp-web" } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("unsupported transport");
  });

  it("sanitizes odd server ids instead of discarding them", () => {
    const config = buildConfig({
      enabled: true,
      servers: { "GitHub Cloud": { command: "mcp-github" } },
    });

    expect(resolveMcpServers(config).map((server) => server.id)).toEqual(["github_cloud"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips a server whose id has no usable characters", () => {
    const config = buildConfig({ enabled: true, servers: { "***": { command: "mcp-x" } } });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("no usable characters");
  });

  it("keeps the first server when two ids sanitize to the same value", () => {
    const config = buildConfig({
      enabled: true,
      servers: {
        "GitHub Cloud": { command: "first" },
        github_cloud: { command: "second" },
      },
    });

    const servers = resolveMcpServers(config);

    expect(servers.map((server) => server.command)).toEqual(["first"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects a command with arguments embedded in it", () => {
    const config = buildConfig({
      enabled: true,
      servers: { github: { command: "npx -y @modelcontextprotocol/server-github" } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      'MCP server "github" command must be the bare executable; move "-y @modelcontextprotocol/server-github" into args',
    );
  });

  it("keeps a clean command with its args", () => {
    const config = buildConfig({
      enabled: true,
      servers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
    });

    const [server] = resolveMcpServers(config);

    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips a server whose args is not an array", () => {
    const config = buildConfig({
      enabled: true,
      servers: { broken: { command: "mcp-x", args: "a b" as never } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("args must be an array of strings");
  });

  it("drops non-string args one by one and warns for each", () => {
    const config = buildConfig({
      enabled: true,
      servers: { files: { command: "mcp-files", args: ["--port", 8080, null, {}, "--root"] } },
    });

    const [server] = resolveMcpServers(config);

    expect(server.args).toEqual(["--port", "--root"]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain("args[1]");
    expect(String(warn.mock.calls[1][0])).toContain("args[2]");
    expect(String(warn.mock.calls[2][0])).toContain("args[3]");
  });

  it("keeps only string env values and warns for the dropped keys", () => {
    const config = buildConfig({
      enabled: true,
      servers: { files: { command: "mcp-files", env: { TOKEN: "secret", PORT: 8080 } as never } },
    });

    const [server] = resolveMcpServers(config);

    expect(server.env).toEqual({ TOKEN: "secret" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PORT");
  });

  it("skips a server whose env is not an object", () => {
    const config = buildConfig({
      enabled: true,
      servers: { broken: { command: "mcp-x", env: "TOKEN=secret" as never } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("env must be an object of strings");
  });

  it("keeps distinct ids that only differ in inner underscores", () => {
    const config = buildConfig({
      enabled: true,
      servers: { a__b: { command: "first" }, a_b: { command: "second" } },
    });

    expect(resolveMcpServers(config).map((server) => server.id)).toEqual(["a__b", "a_b"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips a server explicitly disabled", () => {
    const config = buildConfig({
      enabled: true,
      servers: { off: { command: "mcp-off", enabled: false } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
  });

  it("keeps other servers when one is explicitly disabled", () => {
    const config = buildConfig({
      enabled: true,
      servers: { off: { command: "mcp-off", enabled: false }, on: { command: "mcp-on" } },
    });

    expect(resolveMcpServers(config).map((server) => server.id)).toEqual(["on"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a server whose enabled is a malformed value", () => {
    for (const enabled of ["false", "true", 0, 1, null]) {
      warn.mockClear();
      const config = buildConfig({
        enabled: true,
        servers: {
          odd: { command: "mcp-odd", enabled: enabled as never },
          ok: { command: "mcp-ok" },
        },
      });

      expect(resolveMcpServers(config).map((server) => server.id)).toEqual(["ok"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("non-boolean enabled");
    }
  });

  it("treats a malformed master switch as off and warns", () => {
    for (const enabled of ["false", "true", 0, 1, null]) {
      warn.mockClear();
      const config = buildConfig({
        enabled: enabled as never,
        servers: { github: { command: "npx" } },
      });

      expect(resolveMcpServers(config)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("mcp.enabled is not a boolean");
    }
  });

  it("rejects a command whose path contains spaces without blaming the launcher form", () => {
    const config = buildConfig({
      enabled: true,
      servers: { app: { command: "/Applications/My App/bin/server" } },
    });

    expect(resolveMcpServers(config)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const reason = String(warn.mock.calls[0][0]);

    expect(reason).toContain("path contains spaces are not supported");
    expect(reason).not.toContain("move ");
  });

  it("suggests moving the rest into args for a known launcher", () => {
    for (const launcher of ["npx", "pnpm", "node", "uvx", "python", "deno", "bun"]) {
      warn.mockClear();
      const config = buildConfig({
        enabled: true,
        servers: { srv: { command: `${launcher} -y @scope/server` } },
      });

      expect(resolveMcpServers(config)).toEqual([]);
      expect(String(warn.mock.calls[0][0])).toContain('move "-y @scope/server" into args');
    }
  });

  it("does not throw when a dropped arg cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const config = buildConfig({
      enabled: true,
      servers: {
        files: { command: "mcp-files", args: [10n, circular, "--root"] as never },
      },
    });

    const [server] = resolveMcpServers(config);

    expect(server.args).toEqual(["--root"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("args[0]");
    expect(String(warn.mock.calls[0][0])).toContain("10");
    expect(String(warn.mock.calls[1][0])).toContain("args[1]");
  });

  it("does not throw when a dropped env value cannot be stringified", () => {
    const config = buildConfig({
      enabled: true,
      servers: { files: { command: "mcp-files", env: { BIG: 10n } as never } },
    });

    const [server] = resolveMcpServers(config);

    expect(server.env).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("BIG");
  });

  it("coerces a non-boolean untrusted to false", () => {
    const config = buildConfig({
      enabled: true,
      servers: {
        loose: { command: "mcp-loose", untrusted: "yes" as never },
        strict: { command: "mcp-strict", untrusted: true },
      },
    });

    expect(resolveMcpServers(config).map((server) => server.untrusted)).toEqual([false, true]);
  });
});

describe("Config mcp defaults", () => {
  it("keeps MCP disabled and fills the numeric defaults", async () => {
    const config = await loadConfig({ providers: {} });

    expect(config.config.mcp).toEqual({
      enabled: false,
      servers: {},
      maxDescriptionChars: 300,
      maxToolsIndexChars: 2000,
      startupTimeoutMs: 10_000,
      callTimeoutMs: 60_000,
      maxConcurrentCalls: 4,
    });
  });

  it("respects an explicit mcp block from the config file", async () => {
    const config = await loadConfig({
      providers: {},
      mcp: { enabled: true, servers: { github: { command: "npx" } }, callTimeoutMs: 1_000 },
    });

    expect(config.config.mcp?.enabled).toBe(true);
    expect(config.config.mcp?.callTimeoutMs).toBe(1_000);
    expect(config.config.mcp?.startupTimeoutMs).toBe(10_000);
    expect(Object.keys(config.config.mcp?.servers ?? {})).toEqual(["github"]);
  });
});
