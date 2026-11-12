import { AsyncLocalStorage } from "node:async_hooks";
import type { ObjectStore } from "./object-store.js";

/**
 * Vercel Blob 요금 단위로 센 작업 수입니다.
 * - `advanced`: 쓰기와 list. list는 호출 한 번을 1로 세므로, 한 prefix가 1,000개를 넘어 여러 page가 되면 실제보다 적습니다.
 * - `simple`: 읽기. Blob은 cache MISS만 과금하므로 실제보다 많을 수 있는 상한입니다.
 * delete는 무료라 세지 않습니다. 조건이 맞지 않아 실패한 쓰기도 요청은 보냈으므로 셉니다.
 */
export interface BlobOperationCount {
  advanced: number;
  simple: number;
}

export function emptyOperationCount(): BlobOperationCount {
  return { advanced: 0, simple: 0 };
}

// 한 Function 인스턴스가 여러 요청을 동시에 처리해도 실행마다 따로 세도록 async context로 묶습니다.
const scope = new AsyncLocalStorage<BlobOperationCount>();

/** `run` 안에서 `countingStore()`를 거친 작업을 `count`에 더합니다. 범위 밖의 작업은 세지 않습니다. */
export function countOperations<T>(count: BlobOperationCount, run: () => Promise<T>): Promise<T> {
  return scope.run(count, run);
}

/** 실행 중인 `countOperations()` 범위에 작업을 더하는 store입니다. */
export function countingStore(store: ObjectStore): ObjectStore {
  const add = (kind: keyof BlobOperationCount) => {
    const count = scope.getStore();
    if (count !== undefined) count[kind] += 1;
  };
  return {
    access: store.access,
    read(pathname, signal) {
      add("simple");
      return store.read(pathname, signal);
    },
    write(pathname, body, options) {
      add("advanced");
      return store.write(pathname, body, options);
    },
    list(prefix) {
      add("advanced");
      return store.list(prefix);
    },
    delete(pathnames) {
      return store.delete(pathnames);
    },
  };
}
