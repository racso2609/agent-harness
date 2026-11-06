#!/usr/bin/env node
// Minimal MCP server over stdio, written by hand so the tests do not depend on
// the SDK. It speaks newline-delimited JSON-RPC 2.0 (the framing used by the
// SDK stdio transport: one JSON message per line on stdin/stdout) and answers
// only what the harness client needs:
//
//   initialize                  -> protocolVersion, capabilities.tools, serverInfo
//   notifications/initialized   -> ignored (notification)
//   ping                        -> {}
//   tools/list                  -> "echo" (readOnlyHint: true, real inputSchema),
//                                  "fail" and "slow"
//   tools/call                  -> text content for "echo"/"slow", isError for "fail"
//
// Any other request gets a JSON-RPC -32601 error.
//
// Modes (flags, or the same names without dashes as env vars, e.g. HANG=1):
//
//   --hang            Never answers `initialize`; proves the handshake timeout.
//                     Stays alive and keeps reading stdin.
//   --exit-on-start   Exits immediately with code 3, before reading anything.
//   --slow-call       Answers `tools/call` after CALL_DELAY_MS (default 5000),
//                     unless the client cancels (notifications/cancelled).
//   --all-pages       Splits `tools/list` in two pages and expects the client to
//                     follow the `nextCursor` of the first one.

import process from "node:process";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const env = (name) => process.env[name] === "1" || process.env[name] === "true";

const has = (flag) => flags.has(flag) || env(flag.replace(/^--/, "").replace(/-/g, "_"));

const HANG = has("--hang");
const EXIT_ON_START = has("--exit-on-start");
const SLOW_CALL = has("--slow-call");
const ALL_PAGES = has("--all-pages");

const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS ?? 5000);

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "echo",
    description: "Echoes back the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail",
    description: "Always reports an error",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Answers very late",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
];

if (EXIT_ON_START) {
  // Nothing on stdout: a server that dies before the handshake looks exactly
  // like this to the client.
  process.stderr.write("minimalServer: exiting on start\n");
  process.exit(3);
}

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id, result) => write({ jsonrpc: "2.0", id, result });

const respondError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

// Calls still pending, so a cancellation can drop them.
const pendingCalls = new Map();

const listToolsPage = (cursor) => {
  if (!ALL_PAGES) return { tools: TOOLS };

  // Two pages: [echo] then [fail, slow].
  if (!cursor) return { tools: TOOLS.slice(0, 1), nextCursor: "page-2" };
  if (cursor === "page-2") return { tools: TOOLS.slice(1) };

  return { tools: [] };
};

const toolText = (name, args) => {
  if (name === "echo") return typeof args?.text === "string" ? args.text : "";
  return `${name} ok`;
};

const handleCall = (id, params) => {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = params?.arguments;

  if (SLOW_CALL) {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      if (name === "fail") {
        respond(id, { content: [{ type: "text", text: "slow failure" }], isError: true });
        return;
      }

      respond(id, { content: [{ type: "text", text: toolText(name, args) }] });
    }, CALL_DELAY_MS);

    pendingCalls.set(id, () => clearTimeout(timer));
    return;
  }

  if (name === "fail") {
    respond(id, { content: [{ type: "text", text: "tool failed on purpose" }], isError: true });
    return;
  }

  if (name === "echo" || name === "slow") {
    respond(id, { content: [{ type: "text", text: toolText(name, args) }] });
    return;
  }

  respondError(id, -32602, `Unknown tool: ${name}`);
};

const handleMessage = (message) => {
  if (!message || typeof message !== "object") return;

  const hasId = message.id !== undefined && message.id !== null;
  const method = message.method;

  if (!hasId) {
    // Notification. `notifications/initialized` needs no answer; a
    // cancellation drops the pending call so its timer never fires.
    if (method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      const cancel = pendingCalls.get(requestId);
      if (cancel) {
        pendingCalls.delete(requestId);
        cancel();
      }
    }

    return;
  }

  if (method === "initialize") {
    if (HANG) return;

    respond(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "minimal-server", version: "1.0.0" },
    });
    return;
  }

  if (method === "ping") {
    respond(message.id, {});
    return;
  }

  if (method === "tools/list") {
    respond(message.id, listToolsPage(message.params?.cursor));
    return;
  }

  if (method === "tools/call") {
    handleCall(message.id, message.params);
    return;
  }

  respondError(message.id, -32601, `Method not found: ${method}`);
};

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");

  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);

    if (line.trim()) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }

      handleMessage(message);
    }

    index = buffer.indexOf("\n");
  }
});

// A client closing stdin is the normal way to stop a stdio server.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
