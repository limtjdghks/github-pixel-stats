import type { CheckpointStore, CollectionCheckpoint, StoredCheckpoint } from "../../src/data/checkpoint-model.js";

export class MemoryCheckpointStore implements CheckpointStore {
  private records = new Map<string, { revision: string; json: string }>();
  private sequence = 0;

  async load(key: string, signal: AbortSignal): Promise<StoredCheckpoint | null> {
    signal.throwIfAborted();
    const record = this.records.get(key);
    return record ? { revision: record.revision, value: JSON.parse(record.json) } : null;
  }

  async compareAndSwap(
    key: string,
    expectedRevision: string | null,
    checkpoint: CollectionCheckpoint,
    guard: { owner: string; now: string } | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    signal.throwIfAborted();
    const current = this.records.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return null;
    if (guard) {
      const value = current ? JSON.parse(current.json) as CollectionCheckpoint : null;
      if (!value?.lease || value.lease.owner !== guard.owner ||
        Date.parse(value.lease.expiresAt) <= Date.parse(guard.now)) return null;
    }
    const revision = String(++this.sequence);
    this.records.set(key, { revision, json: JSON.stringify(checkpoint) });
    return revision;
  }

  export(): string {
    return JSON.stringify({ sequence: this.sequence, records: [...this.records] });
  }

  static restore(json: string): MemoryCheckpointStore {
    const parsed = JSON.parse(json) as { sequence: number; records: Array<[string, { revision: string; json: string }]> };
    const store = new MemoryCheckpointStore();
    store.sequence = parsed.sequence;
    store.records = new Map(parsed.records);
    return store;
  }

  rewrite(transform: (checkpoint: CollectionCheckpoint) => unknown): void {
    for (const record of this.records.values()) {
      record.json = JSON.stringify(transform(JSON.parse(record.json) as CollectionCheckpoint));
      record.revision = String(++this.sequence);
    }
  }
}
