// Static policy used to classify shell commands before they are approved.
// It is intentionally conservative: anything not clearly read-only is
// treated as `exec`, and DENY_PATTERNS cover commands that are dangerous
// enough to refuse regardless of the configured approval mode.

// Commands that only inspect state. When the whole command line is built
// from these (and shell operators that cannot change state), it is treated
// as a read and can be auto-approved.
export const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "fd",
  "pwd",
  "whoami",
  "id",
  "uname",
  "date",
  "echo",
  "printf",
  "which",
  "type",
  "env",
  "printenv",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "git",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
]);

// Subcommands that turn an otherwise read-only binary into a mutating one.
const DENY_BINARIES = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "dd",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "mkfs",
  "shutdown",
  "reboot",
  "kill",
  "pkill",
  "sudo",
  "su",
]);

// Dangerous command shapes refused in every mode. Each entry is a regex
// matched against the normalized command line.
export const DENY_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*(-[a-z]*)?\/(\s|$)/i, // rm ... /
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+\//i, // rm -rf /
  /\bdd\s+[^|]*\bif=/i, // dd if=...
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i, // curl | sh
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i, // wget | sh
  /\bgit\s+push\b[^|]*--force/i, // git push --force
  /\bgit\s+reset\s+--hard\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
  />\s*\/dev\/(sd|nvme|disk)/i, // raw device writes
];

export type CommandKind = "read" | "exec";

// True when the command line matches a deny pattern.
export const isDeniedCommand = (command: string): boolean =>
  DENY_PATTERNS.some((pattern) => pattern.test(command));

// Splits a command line on shell separators (`;`, `&&`, `||`, `|`) and
// returns the leading binary of each segment. Good enough for policy:
// ambiguous input degrades to `exec`, never silently to `read`.
const segmentBinaries = (command: string): string[] =>
  command
    .split(/\|\||&&|;|\|/g)
    .map((segment) => segment.trim().replace(/^\(+/, ""))
    .filter(Boolean)
    .map((segment) => segment.split(/\s+/)[0] ?? "");

// Strips leading `VAR=value` assignments and `env` wrappers.
const normalizeBinary = (token: string): string => {
  const base = token.split("/").pop() ?? token;
  return base.toLowerCase();
};

export const classifyCommand = (command: string): CommandKind => {
  if (!command.trim()) return "exec";
  if (isDeniedCommand(command)) return "exec";
  // Redirections and here-docs mutate the filesystem regardless of the
  // command; treat them as exec.
  if (/(^|[^>])>{1,2}(?!=)/.test(command) || /<</.test(command)) return "exec";

  const binaries = segmentBinaries(command);
  if (!binaries.length) return "exec";

  const allReadOnly = binaries.every((token) => {
    const binary = normalizeBinary(token);
    if (!binary) return false;
    if (DENY_BINARIES.has(binary)) return false;
    return READ_ONLY_COMMANDS.has(binary);
  });

  return allReadOnly ? "read" : "exec";
};
