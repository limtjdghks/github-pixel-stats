import { randomUUID } from "node:crypto";
import { GitHubRestPageSource } from "../data/github-pages.js";
import { LinguistClassifier } from "../data/linguist.js";
import { ObjectCheckpointStore } from "../storage/checkpoint-object-store.js";
import { loadPublishedState } from "../storage/private-repository.js";
import { countingStore } from "../storage/operation-count.js";
import type { CardStores } from "../storage/published-card.js";
import type { RefreshDependencies } from "./refresh-job.js";

/**
 * 운영 Blob store와 GitHub token으로 갱신 job 의존성을 만듭니다.
 * 수집 cache는 마지막으로 발행된 release의 state를 사용하고, Linguist 분류기는 Function 인스턴스마다 한 번만 읽습니다.
 * 저장소 작업은 `countOperations()` 범위 안에서 실행하면 그 범위에 집계됩니다.
 */
export function createRefreshDependencies(blobStores: CardStores, githubToken: string): RefreshDependencies {
  const stores = {
    privateStore: countingStore(blobStores.privateStore),
    publicStore: countingStore(blobStores.publicStore),
  };
  let classifier: Promise<LinguistClassifier> | undefined;
  return {
    stores,
    checkpoints: new ObjectCheckpointStore(stores.privateStore),
    loadState: (username) => loadPublishedState(stores.privateStore, username),
    github: new GitHubRestPageSource(githubToken),
    // 읽기에 실패한 Promise를 남기면 인스턴스가 살아 있는 동안 계속 실패하므로 지웁니다.
    loadClassifier: () => (classifier ??= LinguistClassifier.loadDefault().catch((error: unknown) => {
      classifier = undefined;
      throw error;
    })),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
}
