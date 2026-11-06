import type {
MemoryCapabilities,
MemoryContextOptions,
MemoryHit,
MemoryObservation,
MemoryProvider,
MemoryQuery,
} from "./Memory";

// Does nothing at all. It is what `memory.enabled = false` resolves to, so the
// rest of the harness can hold a provider without branching on "is memory on?"
// and the prompt and the history stay byte-identical to a build without memory.
export class NoopMemoryProvider implements MemoryProvider {
readonly id = "none";

capabilities(): MemoryCapabilities {
return {
search: false,
context: false,
capture: false,
forget: false,
semantic: false,
scopes: [],
};
}

// A healthy no-op is not a failure: the provider is fine, it just has
// nothing to say.
async health(): Promise<{ ok: boolean; detail?: string }> {
return { ok: true };
}

// The parameter is only there to match the interface: nothing is searched.
async search(query: MemoryQuery): Promise<MemoryHit[]> {
void query;
return [];
}

// The parameter is only there to match the interface: nothing is rendered.
async context(options: MemoryContextOptions): Promise<string> {
void options;
return "";
}

// The parameter is only there to match the interface: nothing is stored.
async capture(observation: MemoryObservation): Promise<{ id: string }> {
void observation;
return { id: "" };
}

// The parameter is only there to match the interface: nothing is deleted.
async forget(id: string): Promise<boolean> {
void id;
return false;
}

async close(): Promise<void> {}
}
