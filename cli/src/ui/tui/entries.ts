// Per-role anchors for the TUI transcript.
//
// The transcript is one array but three roles stream into it: the answer, the
// reasoning and the output of the running command. Picking the last entry to
// decide where a delta goes breaks the moment something else is written in
// between (a child settling drops a notice in the middle of the parent's
// stream) and the answer ends up painted twice. These helpers remember the
// index of the entry each role is writing, so an interleaved entry cannot
// split it.

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

// Keeps the transcript bounded. Trimming shifts every index, so the anchors
// move with the window: they are re-based on the new start, and the ones whose
// entry fell out of it are dropped (that role just opens a new entry the next
// time it writes).
export const trimAnchored = <T>(
lines: T[],
anchors: RoleAnchors,
max: number,
): AnchoredWrite<T> => {
if (lines.length <= max) return { lines, anchors };

const dropped = lines.length - max;
const shifted: RoleAnchors = {};

for (const role of Object.keys(anchors) as StreamRole[]) {
const index = anchors[role];

if (index != null && index >= dropped) shifted[role] = index - dropped;
}

return { lines: lines.slice(dropped), anchors: shifted };
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
const open =
index != null && lines[index]?.role === role ? lines[index] : undefined;
const next = [...lines];

if (open && index != null) {
next[index] = update(open);
} else {
next.push(update(undefined));
}

const written = open && index != null ? index : next.length - 1;

return trimAnchored(next, { ...anchors, [role]: written }, max);
};
