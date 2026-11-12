import type { CheckpointStore, CollectionCheckpoint, StoredCheckpoint } from "../data/checkpoint-model.js";
import type { ObjectStore } from "./object-store.js";
import { checkpointPathname } from "./pathnames.js";
import { JSON_CONTENT_TYPE, PRIVATE_CACHE_SECONDS } from "./private-repository.js";

function hasLease(stored: string, guard: { owner: string; now: string }): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return false;
  }
  const lease = (value as Partial<CollectionCheckpoint> | null)?.lease;
  return typeof lease?.owner === "string" && lease.owner === guard.owner &&
    typeof lease.expiresAt === "string" && Date.parse(lease.expiresAt) > Date.parse(guard.now);
}

/**
 * HOST-03 checkpoint 계약을 private object store에 연결합니다.
 * revision은 객체 ETag이며, 교체는 ETag 조건부 쓰기로만 수행해 lost update를 막습니다.
 */
export class ObjectCheckpointStore implements CheckpointStore {
  constructor(private readonly store: ObjectStore) {
    if (store.access !== "private") {
      throw new Error("Checkpoints require a private store.");
    }
  }

  async load(key: string, signal: AbortSignal): Promise<StoredCheckpoint | null> {
    const stored = await this.store.read(checkpointPathname(key), signal);
    if (stored === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(stored.body);
    } catch {
      throw new Error("Checkpoint is not valid JSON.");
    }
    return { revision: stored.etag, value };
  }

  async compareAndSwap(
    key: string,
    expectedRevision: string | null,
    checkpoint: CollectionCheckpoint,
    guard: { owner: string; now: string } | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    const pathname = checkpointPathname(key);
    if (guard !== null) {
      // revision 일치는 아래 ETag 조건부 쓰기가 판정합니다. Blob은 read와 write가 ETag를 다른 응답에서
      // 받으므로 여기서 문자열로 비교하지 않고, lease 소유권만 확인합니다.
      const current = await this.store.read(pathname, signal);
      if (current === null || !hasLease(current.body, guard)) {
        return null;
      }
    }
    return this.store.write(pathname, JSON.stringify(checkpoint), {
      contentType: JSON_CONTENT_TYPE,
      cacheControlMaxAge: PRIVATE_CACHE_SECONDS,
      condition: expectedRevision === null ? { kind: "absent" } : { kind: "match", etag: expectedRevision },
      signal,
    });
  }
}
