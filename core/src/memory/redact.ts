// Secret patterns seen most often in transcripts. Each one keeps enough of the
// marker to stay readable but never the credential: the replacement is the same
// literal, so applying redact twice yields the same string.
const REDACTED = "[redacted]";

const PATTERNS: [RegExp, string][] = [
  // OpenAI/Anthropic keys: sk-, sk-ant-, sk-proj- followed by the key body.
  // Six characters minimum (the spec's example is "sk-abc123") still leaves
  // ordinary words such as "sk-learn" alone.
  [/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTED],
  // Authorization headers.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // key=value assignments. The value stops at whitespace or the end of the line.
  [
    /\b(apikey|api_key|token|password|secret)(\s*[=:]\s*)["']?[^\s"']{4,}["']?/gi,
    `$1$2${REDACTED}`,
  ],
  // AWS access key ids.
  [/\bAKIA[A-Z0-9]{16}\b/g, REDACTED],
];

// Replaces the common secret shapes in a text before it is persisted. It is a
// best-effort filter, not a guarantee: unknown formats go through untouched.
export const redact = (text: string): string =>
  PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
