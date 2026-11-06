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
//   --grandchild-records-sigterm <file>
//                     Spawns a grandchild that appends to <file> when it gets
//                     SIGTERM and how long it stayed alive afterwards, so a
//                     test can watch the escalation from the grandchild.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
// Value of a flag that takes an argument, e.g. `--grandchild-records-sigterm
// /tmp/records.txt`.
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const env = (name) => process.env[name] === "1" || process.env[name] === "true";

const has = (flag) => flags.has(flag) || env(flag.replace(/^--/, "").replace(/-/g, "_"));

const HANG = has("--hang");
const EXIT_ON_START = has("--exit-on-start");
const SLOW_CALL = has("--slow-call");
const ALL_PAGES = has("--all-pages");
const ENDLESS_PAGES = has("--endless-pages");
const CODEX_PAGES = has("--codex-pages");
const GRANDCHILD = has("--grandchild");
const ABORT_PROOF = has("--abort-proof");

const CALL_DELAY_MS = Number(process.env.CALL_DELAY_MS ?? 5000);
const GRANDCHILD_PID_FILE = process.env.GRANDCHILD_PID_FILE;
const GRANDCHILD_SIGTERM_FILE = argValue("--grandchild-records-sigterm");
// Handed to every grandchild as an environment variable and stamped into its
// process title, so a test can find and sweep the descendants of an earlier
// server by either half of the marker, even after they were re-parented.
const FIXTURE_TAG = process.env.FIXTURE_TAG ?? "";

// Ignores SIGTERM and never exits on its own: only SIGKILL takes it down.
const REFUSES_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

// A grandchild that reports the escalation it is put through, so a test can
// tell a real SIGTERM-then-SIGKILL grace period from both signals landing in
// the same instant. It appends `started` on boot, `sigterm` when the signal
// arrives, a heartbeat every 20 ms with the time elapsed since, and
// `survived <ms>` if it is still alive 400 ms later. A SIGKILL that follows
// the SIGTERM immediately leaves no heartbeat behind, which is exactly what
// the test looks for.
const recordsSigterm = (file) => `
const { appendFileSync } = require("node:fs");
const file = ${JSON.stringify(file)};
const started = Date.now();
appendFileSync(file, "started\\n");
process.on("SIGTERM", () => {
  const at = Date.now();
  appendFileSync(file, "sigterm\\n");
  setInterval(() => appendFileSync(file, "alive " + (Date.now() - at) + "\\n"), 20).unref();
  setTimeout(() => {
    appendFileSync(file, "survived " + (Date.now() - started) + "\\n");
    process.exit(0);
  }, 400).unref();
});
setInterval(() => {}, 1000);
`;

// Children this server spawned and must take down with it: a server that
// exits while a grandchild runs leaves it re-parented to init, out of reach
// of any later process-tree walk of the server.
const spawnedChildren = [];

// A child of the server that refuses SIGTERM, so only a real tree kill or a
// SIGKILL escalation gets rid of it. Its pid is handed out through the
// "grandchild" tool and, when asked for, through a file. A tagged grandchild
// carries the marker in its environment and in its title, which is what a
// `ps -E` sweep looks for either way.
const startGrandchild = () => {
  const marker = FIXTURE_TAG ? `fixture-grandchild:${FIXTURE_TAG}` : "";
  const body = GRANDCHILD_SIGTERM_FILE ? recordsSigterm(GRANDCHILD_SIGTERM_FILE) : REFUSES_SIGTERM;
  const script = marker ? `process.title = ${JSON.stringify(marker)}; ${body}` : body;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    // A real variable, not just a marker in the title: a sweep that looks for
    // either one has to find this process.
    env: { ...process.env, FIXTURE_TAG },
  });

  if (child.pid) {
    spawnedChildren.push(child.pid);
    if (GRANDCHILD_PID_FILE) writeFileSync(GRANDCHILD_PID_FILE, String(child.pid), "utf8");
  }

  // A dead child's pid can be recycled by an unrelated process, and a
  // deferred SIGKILL aimed at it would then land on the wrong one.
  child.on("exit", () => {
    const index = spawnedChildren.indexOf(child.pid);
    if (index !== -1) spawnedChildren.splice(index, 1);
  });

  return child.pid;
};

const GRANDCHILD_PID = GRANDCHILD ? startGrandchild() : undefined;

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
  if (ENDLESS_PAGES) {
    const page = Number(cursor ?? 0);
    return { tools: [], nextCursor: String(page + 1) };
  }

  // Repeats "echo" on the second page with a different description, so a
  // de-duplicating client keeps the first one.
  if (CODEX_PAGES) {
    if (!cursor) return { tools: [TOOLS[0], TOOLS[1]], nextCursor: "page-2" };
    if (cursor === "page-2") return { tools: [{ ...TOOLS[0], description: "Repeated name" }] };
    return { tools: [] };
  }

  if (!ALL_PAGES) return { tools: TOOLS };

  // Two pages: [echo] then [fail, slow, env, grandchild].
  if (!cursor) return { tools: TOOLS.slice(0, 1), nextCursor: "page-2" };
  if (cursor === "page-2") return { tools: TOOLS.slice(1) };

  return { tools: [] };
};

const toolText = (name, args) => {
  if (name === "echo") return typeof args?.text === "string" ? args.text : "";
  if (name === "env") return Object.keys(process.env).sort().join(",");
  if (name === "grandchild") return String(GRANDCHILD_PID ?? "none");
  return `${name} ok`;
};

const handleCall = (id, params) => {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = params?.arguments;

  // Only the "slow" tool is delayed: a "slow" server still answers everything
  // else promptly, which is what lets a test prove the connection is usable
  // after a call was aborted.
  if (SLOW_CALL && name === "slow") {
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

  if (name === "echo" || name === "slow" || name === "env" || name === "grandchild") {
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
    // cancellation drops the pending call so its timer never fires, unless
    // the server ignores cancellations on purpose.
    if (method === "notifications/cancelled" && !ABORT_PROOF) {
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

// Only signals a child that is still there: `process.kill(pid, 0)` is checked
// first, so a signal deferred by the escalation timer never reaches a pid that
// was recycled in the meantime.
const signalChildren = (signal) => {
  for (const pid of [...spawnedChildren]) {
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }

    try {
      process.kill(pid, signal);
    } catch {
      // Died between the check and the signal.
    }
  }
};

// Kills every child this server spawned. A grandchild built to ignore SIGTERM
// must still die with its parent, or it is re-parented to init and outlives
// the whole suite. SIGTERM gets a short grace period while the server keeps
// running, and SIGKILL always follows: the "exit" handler cannot wait, so by
// then the escalation has to be immediate.
let childrenStopped = false;
const stopChildren = (immediate = false) => {
  if (childrenStopped) return;
  childrenStopped = true;

  signalChildren("SIGTERM");
  if (immediate) {
    signalChildren("SIGKILL");
    return;
  }

  const escalation = setTimeout(() => signalChildren("SIGKILL"), 100);
  escalation.unref();
};

// "exit" is the one handler no termination path skips, and it is the last
// chance to act: nothing else runs after it.
process.on("exit", () => stopChildren(true));
process.on("SIGTERM", () => {
  stopChildren();
  setTimeout(() => process.exit(0), 150);
});
process.on("SIGINT", () => {
  stopChildren();
  setTimeout(() => process.exit(0), 150);
});

// A client closing stdin is the normal way to stop a stdio server.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
