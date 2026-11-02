// Pure helpers behind the progress strip. Kept out of the component so the
// visibility and timing rules are testable without mounting ink.

export interface SpawnView {
  handle: {
    spawnId: string;
    agentId: string;
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
  status: string;
  startedAt: string;
  finishedAt?: string;
}): SpawnEntry => ({
  id: handle.spawnId,
  agent: handle.agentId,
  status: handle.status,
  startedAt: handle.startedAt,
  finishedAt: handle.finishedAt,
});

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

  return "◐";
};

export const colorFor = (status: string): string | undefined => {
  if (status === "done") return "green";
  if (status === "error") return "red";

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
