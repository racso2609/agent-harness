// Pure helpers behind the progress strip. Kept out of the component so the
// visibility and timing rules are testable without mounting ink.

import { truncateCell } from "./layout";

export interface SpawnView {
  handle: {
    spawnId: string;
    agentId: string;
    // Original prompt the child was launched with. The core sets it on every
    // handle, restored ones included, so two children of the same agent can
    // be told apart on the strip.
    prompt: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
  };
}

// How long a settled child stays visible after it is done, so a fast child is
// perceivable instead of flashing by.
export const SPAWN_LINGER_MS = 5_000;

export interface SpawnEntry {
  id: string;
  agent: string;
  // What the child was asked to do. May span several lines: the row paints it
  // through `promptFor`, which folds it onto one.
  prompt: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  // Came from a previous run: it cannot progress, so its clock is frozen.
  restored?: boolean;
}

// Maps a core handle to the shape the strip renders.
export const toSpawnEntry = (handle: {
  spawnId: string;
  agentId: string;
  prompt: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
}): SpawnEntry => ({
  id: handle.spawnId,
  agent: handle.agentId,
  prompt: handle.prompt,
  status: handle.status,
  startedAt: handle.startedAt,
  finishedAt: handle.finishedAt,
});

// Collapses a prompt onto a single line. A child row must stay exactly one
// terminal row — the mouse hit-test maps a terminal row to a child assuming
// one painted row per child — so a prompt written across several lines is
// folded before it is measured. Same rule as `oneLine` in ui/outcome, kept
// here so the strip does not reach into the command layer.
export const oneLinePrompt = (prompt: string): string => prompt.replace(/\s+/g, " ").trim();

// Columns reserved for the prompt in a child row.
//
// The fixed part of the row is roughly 34 columns: icon, space, agent name,
// the two " · " separators, a "spawn-…" id and a 6-character clock. In an
// 80-column terminal PANEL_CHROME leaves 60 columns for the pane, so 24 for
// the context keeps the whole row inside a single line with room to spare on
// narrower terminals instead of letting ink wrap it onto a second row.
export const PROMPT_COLUMNS = 24;

// The prompt as a child row paints it: one line, cut on a column boundary so
// a double-width character is never split in half.
export const promptFor = (spawn: SpawnEntry, width = PROMPT_COLUMNS): string =>
  truncateCell(oneLinePrompt(spawn.prompt), width);

// A child is visible while running and for SPAWN_LINGER_MS after settling.
export const visibleSpawns = (spawns: SpawnEntry[], now: number): SpawnEntry[] =>
  spawns.filter((spawn) => {
    if (spawn.status === "running") return true;
    if (!spawn.finishedAt) return true;

    return now - Date.parse(spawn.finishedAt) < SPAWN_LINGER_MS;
  });

// Elapsed time for the strip: running children count up, settled ones freeze.
// A restored child never ticks: it belongs to a past process, so the clock
// stays where it stopped and a child that was running when the session ended
// reads as interrupted instead of pretending to run.
export const elapsedFor = (spawn: SpawnEntry, now: number): string => {
  if (!spawn.startedAt) return spawn.status;
  if (spawn.restored && spawn.status === "running" && !spawn.finishedAt) {
    return "interrupted";
  }

  const end = spawn.finishedAt
    ? Date.parse(spawn.finishedAt)
    : spawn.restored
      ? Date.parse(spawn.startedAt)
      : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(spawn.startedAt)) / 1000));

  if (spawn.status === "running") return `${seconds}s`;

  return `${spawn.status} in ${seconds}s`;
};

export const iconFor = (status: string): string => {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  // A slashed circle, so a child the user gave up on never reads as a live
  // spinner nor as a failure of its own.
  if (status === "cancelled") return "⊘";

  return "◐";
};

export const colorFor = (status: string): string | undefined => {
  if (status === "done") return "green";
  if (status === "error") return "red";
  // Yellow, not red: cancelled is something the user asked for, not a fault.
  if (status === "cancelled") return "yellow";

  return "cyan";
};

// How many children of past runs stay on screen. The strip is not a log: an
// old session with dozens of children must not push the conversation away, so
// the oldest are counted instead of listed.
export const RESTORED_LIMIT = 5;

export interface SpawnStripRow extends SpawnEntry {
  restored: boolean;
}

// Rows of the strip: the children of this process (with their linger window)
// first, then the most recent ones restored from a previous run. A live child
// is never listed twice, even while its handle is still in the history.
export const spawnStrip = (
  live: SpawnEntry[],
  history: SpawnEntry[],
  now: number,
): { rows: SpawnStripRow[]; hidden: number } => {
  const liveIds = new Set(live.map((spawn) => spawn.id));
  const rows: SpawnStripRow[] = visibleSpawns(live, now).map((spawn) => ({
    ...spawn,
    restored: false,
  }));

  const past = history
    .filter((spawn) => !liveIds.has(spawn.id))
    .map((spawn) => ({ ...spawn, restored: true }))
    .reverse();

  rows.push(...past.slice(0, RESTORED_LIMIT));

  return { rows, hidden: past.length - Math.min(past.length, RESTORED_LIMIT) };
};

// Only a running child of THIS process can be stopped. A settled one has no
// work left to abort, and one restored from a previous run does not even live
// in this process — offering the click on either would be a lie.
export const stoppable = (row: SpawnStripRow): boolean => row.status === "running" && !row.restored;

export interface StripGeometry {
  // 0-based row inside the ink viewport where the top border of the strip starts.
  top: number;
  // Rows painted inside the strip: one per child plus, when at least one
  // restored child was clipped, the "+N older" counter row. It does NOT count
  // the borders, and the counter is not a child: reports landing on it fall
  // past `children - 1` and resolve to null, which is what makes a click there
  // do nothing.
  children: number;
  // True when the strip paints the "+N older" counter row under the children
  // (i.e. `children` charges one row that is not a child). The field is named
  // for what it means, not for the rows: a true here means "there is a counter
  // to skip", never "rows are hidden".
  hasCounter: boolean;
}

// Mouse report row (1-based, as SGR sends it) -> index in `strip.rows`, or null.
//
// The arithmetic lives here instead of the JSX on purpose: a click landing on
// the wrong child is a bug no snapshot of the rendered tree would catch, and a
// pure function can be tested by moving the strip one row and checking the hit
// moves with it.
export const stripRowAt = (report: { row: number }, geometry: StripGeometry): number | null => {
  // The strip has one row of top border (STRIP_BORDER_ROWS counts both), so the
  // first child sits one row below `top`.
  const local = report.row - 1 - (geometry.top + 1);

  if (local < 0 || local >= geometry.children) return null;

  return local;
};
