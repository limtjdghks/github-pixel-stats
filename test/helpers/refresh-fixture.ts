import type { PageRequest, PageResult } from "../../src/data/github-pages.js";
import { LinguistClassifier } from "../../src/data/linguist.js";
import type { RefreshDependencies } from "../../src/hosting/refresh-job.js";
import type { SearchCommit } from "../../src/model.js";
import { ObjectCheckpointStore } from "../../src/storage/checkpoint-object-store.js";
import { loadPublishedState } from "../../src/storage/private-repository.js";
import { MemoryObjectStore } from "./memory-object-store.js";

export const REFRESH_NOW = Date.parse("2026-10-01T12:00:00.000Z");
const classifierPromise = LinguistClassifier.loadDefault();

/**
 * 갱신 job·Cron·bootstrap 테스트용 운영 구성과 같은 의존성입니다.
 * 저장소는 in-memory adapter이고 GitHub는 사용자마다 commit 2개를 돌려주는 fake page source입니다.
 * `missing`에 넣은 사용자는 profile 요청이 404로 실패합니다.
 */
export function refreshFixture() {
  const clock = { now: REFRESH_NOW };
  const now = () => new Date(clock.now);
  const privateStore = new MemoryObjectStore("private", now);
  const publicStore = new MemoryObjectStore("public", now);
  const calls: PageRequest[] = [];
  const missing = new Set<string>();
  let serial = 0;
  const commitsFor = (username: string): SearchCommit[] => [1, 2].map((index) => ({
    repositoryId: 1,
    repository: `${username}/repo`,
    sha: `${username.length}${index}`.padStart(40, "0"),
    authoredAt: new Date(REFRESH_NOW - index * 3_600_000).toISOString(),
  }));
  const page = (request: PageRequest): PageResult => {
    switch (request.kind) {
      case "profile":
        if (missing.has(request.username.toLowerCase())) throw new Error("GitHub API 404 for /users.");
        return { kind: "profile", login: request.username, publicRepositories: 1 };
      case "repositories": return { kind: "repositories", stars: 2, hasNext: false };
      case "search": {
        const found = commitsFor(request.username)
          .filter((commit) => Date.parse(commit.authoredAt) >= request.from && Date.parse(commit.authoredAt) <= request.to);
        return { kind: "search", commits: found, totalCount: found.length, incomplete: false, hasNext: false };
      }
      case "files": return { kind: "files", filenames: ["src/main.ts"], fileCount: 1, hasNext: false };
    }
  };
  const dependencies: RefreshDependencies = {
    stores: { privateStore, publicStore },
    github: {
      async requestPage(request, signal) {
        signal.throwIfAborted();
        calls.push(structuredClone(request));
        return page(request);
      },
    },
    checkpoints: new ObjectCheckpointStore(privateStore),
    loadState: (username) => loadPublishedState(privateStore, username),
    loadClassifier: () => classifierPromise,
    now,
    newId: () => `id-${++serial}`,
  };
  return { clock, privateStore, publicStore, calls, missing, dependencies };
}
