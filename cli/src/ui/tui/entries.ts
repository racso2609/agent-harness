// Per-role anchors for the TUI transcript.
//
// The transcript is one array but three roles stream into it: the answer, the
// reasoning and the output of the running command. Picking the last entry to
// decide where a delta goes breaks the moment something else is written in
// between (a child settling drops a notice in the middle of the parent's
// stream) and the answer ends up painted twice. These helpers remember the
// index of the entry each role is writing, so an interleaved entry cannot
// split it.

import { gapBefore } from "./layout";

// Roles that grow in place while their content arrives.
export type StreamRole = "answer" | "reasoning" | "tool";

// Index in the transcript of the entry each role is writing right now.
export type RoleAnchors = Partial<Record<StreamRole, number>>;

export interface AnchoredWrite<T> {
  lines: T[];
  anchors: RoleAnchors;
}

// A new turn opens with every role closed.
export const noAnchors = (): RoleAnchors => ({});

// Roles that make up the conversation itself. They are never trimmed: dropping
// a message or the answer that belongs to it would break the transcript the user
// reads back. Everything else (tool output, reasoning, notices) is secondary and
// can be dropped from the head once there are too many.
export const CONVERSATION_ROLES: ReadonlySet<string> = new Set(["user", "answer"]);

// Keeps the secondary entries bounded without ever dropping a message or an
// answer: at most `max` entries whose role is not part of the conversation are
// kept, the oldest ones going first. Trimming shifts every index, so the anchors
// move with the window: they are re-based on the entries that survive, and the
// ones whose entry fell out are dropped (that role just opens a new entry the
// next time it writes).
export const trimAnchored = <T extends { role?: string }>(
  lines: T[],
  anchors: RoleAnchors,
  max: number,
): AnchoredWrite<T> => {
  const trimmable: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    const role = lines[index]?.role;
    if (role == null || !CONVERSATION_ROLES.has(role)) trimmable.push(index);
  }

  if (trimmable.length <= max) return { lines, anchors };

  const drop = new Set(trimmable.slice(0, trimmable.length - max));
  const kept: T[] = [];
  const remap = new Map<number, number>();

  for (let index = 0; index < lines.length; index++) {
    if (drop.has(index)) continue;
    remap.set(index, kept.length);
    kept.push(lines[index]!);
  }

  const shifted: RoleAnchors = {};

  for (const role of Object.keys(anchors) as StreamRole[]) {
    const index = anchors[role];
    if (index == null) continue;

    const mapped = remap.get(index);
    if (mapped != null) shifted[role] = mapped;
  }

  return { lines: kept, anchors: shifted };
};

// One entry as the render consumes it: the line, its index in the whole
// transcript and the air above it, both already resolved.
export interface WindowEntry<T> {
  line: T;
  absolute: number;
  gap: number;
}

// The tail of the transcript that is painted. `start` is the absolute index of
// the first visible entry, and every entry arrives with its own absolute index
// and its gap already resolved, so whoever paints never computes indexes
// again: spacing and expansion read `absolute`, not the position in the window.
export interface EntryWindow<T> {
  start: number;
  entries: WindowEntry<T>[];
}

export const windowOf = <T>(lines: T[], size: number): EntryWindow<T> => {
  const start = Math.max(0, lines.length - size);

  return {
    start,
    entries: lines.slice(start).map((line, index) => {
      const absolute = start + index;

      return { line, absolute, gap: gapBefore(absolute) };
    }),
  };
};

// Writes one entry into the open entry of `role`, or appends a new one when the
// role has none. `update` receives the open line, if any, so a role can append
// to it (tool output) or replace it (streamed markdown).
export const writeAnchored = <T extends { role: string }>(
  lines: T[],
  anchors: RoleAnchors,
  role: StreamRole,
  update: (open: T | undefined) => T,
  max: number,
): AnchoredWrite<T> => {
  const index = anchors[role];
  // The anchor can be stale when the entry it pointed at was trimmed away.
  const open = index != null && lines[index]?.role === role ? lines[index] : undefined;
  const next = [...lines];

  if (open && index != null) {
    next[index] = update(open);
  } else {
    next.push(update(undefined));
  }

  const written = open && index != null ? index : next.length - 1;

  return trimAnchored(next, { ...anchors, [role]: written }, max);
};
