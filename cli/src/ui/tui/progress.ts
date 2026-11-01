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
}

// A child is visible while running and for SPAWN_LINGER_MS after settling.
export const visibleSpawns = (
  spawns: SpawnEntry[],
  now: number,
): SpawnEntry[] =>
  spawns.filter((spawn) => {
    if (spawn.status === "running") return true;
    if (!spawn.finishedAt) return true;

    return now - Date.parse(spawn.finishedAt) < SPAWN_LINGER_MS;
  });

// Elapsed time for the strip: running children count up, settled ones freeze.
export const elapsedFor = (spawn: SpawnEntry, now: number): string => {
  if (!spawn.startedAt) return spawn.status;

  const end = spawn.finishedAt ? Date.parse(spawn.finishedAt) : now;
  const seconds = Math.max(
    0,
    Math.round((end - Date.parse(spawn.startedAt)) / 1000),
  );

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
