/**
 * 로컬 운영자 CLI(`src/cli/ops.ts`)가 실행하는 운영 작업입니다. 공개 endpoint 없이 운영 Blob store에 직접 접근합니다.
 * 삭제·rollback은 `apply`가 false이면 저장소를 바꾸지 않고 바뀔 내용만 돌려줍니다.
 * 계약과 사용 절차는 `docs/hosting/recovery.md`에 있습니다.
 */
import { readCheckpoint } from "../data/checkpoint-validation.js";
import { readAdmissions, updateAdmissions } from "../storage/admissions.js";
import { ObjectCheckpointStore } from "../storage/checkpoint-object-store.js";
import { rolledBackManifest } from "../storage/manifest.js";
import type { ObjectEntry, ObjectStore } from "../storage/object-store.js";
import {
  cardPrefix,
  CHECKPOINT_PREFIX,
  checkpointPathname,
  MANIFEST_PREFIX,
  manifestPathname,
  releasePrefix,
  userKey,
  userKeyFromPathname,
} from "../storage/pathnames.js";
import { readManifest, replaceManifest } from "../storage/private-repository.js";
import type { CardStores } from "../storage/published-card.js";
import { readUsage, type DailyUsage } from "../storage/usage.js";
import { markUserRemoved, restoreRemovedUser } from "./admission-policy.js";

/** 발행되지 않은 `ready` 결과가 이 시간 넘게 그대로이면 발행이 멈춘 사용자로 봅니다. 하루 1회 Cron이 한 번은 시도할 시간입니다. */
export const STUCK_PUBLISH_MS = 24 * 60 * 60 * 1000;

export interface StuckUser {
  username: string;
  /** 발행되지 않은 결과의 checkpoint가 마지막으로 바뀐 시각입니다. */
  readySince: string;
  /** 마지막 성공 발행 시각입니다. 발행된 적이 없으면 null입니다. */
  publishedAt: string | null;
}

export interface ServiceStatus {
  published: number;
  unpublished: number;
  /** 수집 실패 표시된 등록 사용자 key입니다. */
  failed: string[];
  /** 삭제 표시된 사용자 key입니다. */
  removed: string[];
  stuck: StuckUser[];
  /** 발행이 멈췄는지 보려고 읽은 checkpoint가 손상돼 판단하지 못한 사용자 key입니다. */
  unreadable: string[];
}

function signal(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

function byKey(prefix: typeof CHECKPOINT_PREFIX | typeof MANIFEST_PREFIX, entries: readonly ObjectEntry[]): Map<string, Date> {
  const keys = new Map<string, Date>();
  for (const entry of entries) {
    const key = userKeyFromPathname(prefix, entry.pathname);
    if (key !== null) keys.set(key, entry.uploadedAt);
  }
  return keys;
}

/**
 * 서비스 상태를 모읍니다. 목록 조회 2회와 등록 기록 읽기 1회에, 발행이 멈췄을 수 있는 사용자의 checkpoint 읽기만 더합니다.
 * 후보는 checkpoint가 마지막 발행보다 새롭고 `STUCK_PUBLISH_MS` 넘게 바뀌지 않은 사용자이며, 본문이 `ready`인 경우만
 * 발행이 멈춘 사용자로 보고합니다. 예산이 모자라 차례를 기다리는 `paused` 사용자는 넣지 않습니다.
 * 후보 checkpoint가 손상됐으면 상태 전체를 실패시키지 않고 `unreadable`에 넣습니다. 손상된 checkpoint는 Cron이 매번
 * 실패해 바뀌지 않으므로 바로 후보가 되며, 이 명령은 그런 장애를 찾는 데 쓰기 때문입니다.
 */
export async function serviceStatus(store: ObjectStore, now: Date): Promise<ServiceStatus> {
  const [checkpointEntries, manifestEntries] = await Promise.all([store.list(CHECKPOINT_PREFIX), store.list(MANIFEST_PREFIX)]);
  const checkpoints = byKey(CHECKPOINT_PREFIX, checkpointEntries);
  const manifests = byKey(MANIFEST_PREFIX, manifestEntries);
  const { admissions } = await readAdmissions(store, signal());
  const entries = Object.entries(admissions.users);
  const checkpointStore = new ObjectCheckpointStore(store);
  const stuck: StuckUser[] = [];
  const unreadable: string[] = [];
  for (const [key, savedAt] of [...checkpoints].sort(([left], [right]) => left.localeCompare(right))) {
    const publishedAt = manifests.get(key) ?? null;
    if (now.getTime() - savedAt.getTime() < STUCK_PUBLISH_MS || (publishedAt !== null && publishedAt >= savedAt)) continue;
    let checkpoint: ReturnType<typeof readCheckpoint>;
    try {
      const stored = await checkpointStore.load(key, signal());
      checkpoint = stored === null ? null : readCheckpoint(stored.value, key);
    } catch {
      unreadable.push(key);
      continue;
    }
    if (checkpoint?.status !== "ready") continue;
    stuck.push({ username: key, readySince: savedAt.toISOString(), publishedAt: publishedAt?.toISOString() ?? null });
  }
  return {
    published: manifests.size,
    unpublished: [...checkpoints.keys()].filter((key) => !manifests.has(key)).length,
    failed: entries.filter(([, entry]) => entry.failedAt !== null && entry.removedAt === null).map(([key]) => key).sort(),
    removed: entries.filter(([, entry]) => entry.removedAt !== null).map(([key]) => key).sort(),
    stuck,
    unreadable,
  };
}

/** `now`부터 거슬러 `days`일의 사용량 기록입니다. 기록이 없는 날은 빈 기록입니다. */
export async function recentUsage(store: ObjectStore, now: Date, days: number): Promise<DailyUsage[]> {
  const day = 24 * 60 * 60 * 1000;
  const usage: DailyUsage[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    usage.push((await readUsage(store, new Date(now.getTime() - offset * day), signal())).usage);
  }
  return usage;
}

export interface UserDataPlan {
  private: string[];
  public: string[];
}

async function userData(stores: CardStores, key: string): Promise<UserDataPlan> {
  const [releases, cards, manifest, checkpoint] = await Promise.all([
    stores.privateStore.list(releasePrefix(key)),
    stores.publicStore.list(cardPrefix(key)),
    stores.privateStore.read(manifestPathname(key), signal()),
    stores.privateStore.read(checkpointPathname(key), signal()),
  ]);
  return {
    private: [
      ...(manifest === null ? [] : [manifestPathname(key)]),
      ...(checkpoint === null ? [] : [checkpointPathname(key)]),
      ...releases.map((entry) => entry.pathname).sort(),
    ],
    public: cards.map((entry) => entry.pathname).sort(),
  };
}

/**
 * 미리보기는 지울 대상(`planned`)만, 실제 삭제는 지운 객체(`deleted`)와 삭제 뒤 다시 확인했을 때 남은 객체(`remaining`)를
 * 돌려줍니다. `remaining`은 삭제 도중 실행 중이던 수집·발행이 쓴 객체이며, 다시 실행하면 지워집니다.
 */
export type DeletePreview = { planned: UserDataPlan };
export type DeleteResult = { deleted: UserDataPlan; remaining: UserDataPlan };

/**
 * 사용자 데이터를 지우고 재수집을 막습니다. 먼저 삭제 표시를 남겨 이후 bootstrap·Cron이 수집하지 않게 한 뒤
 * manifest·checkpoint·release·카드를 지웁니다. `apply`가 false이면 지울 대상만 돌려줍니다.
 * Vercel CDN에 cache된 카드 응답은 cache가 만료될 때까지 남습니다.
 */
export async function deleteUser(stores: CardStores, username: string, now: Date, apply: false): Promise<DeletePreview>;
export async function deleteUser(stores: CardStores, username: string, now: Date, apply: true): Promise<DeleteResult>;
export async function deleteUser(stores: CardStores, username: string, now: Date, apply: boolean): Promise<DeletePreview | DeleteResult>;
export async function deleteUser(stores: CardStores, username: string, now: Date, apply: boolean): Promise<DeletePreview | DeleteResult> {
  const key = userKey(username);
  if (!apply) return { planned: await userData(stores, key) };
  await updateAdmissions(stores.privateStore, (current) => markUserRemoved(current, key, now), signal());
  // 표시를 남긴 뒤 다시 모아, 그 사이 다른 실행이 쓴 객체도 함께 지웁니다.
  const targets = await userData(stores, key);
  await Promise.all([stores.privateStore.delete(targets.private), stores.publicStore.delete(targets.public)]);
  return { deleted: targets, remaining: await userData(stores, key) };
}

/** 삭제 표시를 풉니다. 표시가 없었으면 false입니다. */
export async function restoreUser(store: ObjectStore, username: string): Promise<boolean> {
  const key = userKey(username);
  const before = (await readAdmissions(store, signal())).admissions;
  if (restoreRemovedUser(before, key) === null) return false;
  await updateAdmissions(store, (current) => restoreRemovedUser(current, key), signal());
  return true;
}

export interface RollbackPlan {
  from: { version: string; generatedAt: string };
  to: { version: string; generatedAt: string };
  /** 지울 checkpoint가 있는지입니다. */
  checkpoint: boolean;
}

/**
 * 직전 release를 current로 올립니다. 먼저 checkpoint를 지워, 잘못된 결과가 `ready`로 남아 다음 Cron에서 다시
 * 발행되지 않게 합니다. 다음 갱신은 manifest 교체 시각부터 갱신 간격이 지난 뒤 새 수집으로 시작합니다.
 * manifest가 없거나 직전 release가 없거나 수집 lease가 살아 있으면 아무것도 바꾸지 않고 던집니다.
 * checkpoint를 지운 뒤 manifest가 바뀌어 있으면 manifest는 그대로 두고 던집니다. 그 사이 다른 발행이 끼어들었다면
 * previous가 되돌리려던 release일 수 있으므로, 호출자는 미리보기부터 다시 확인해야 합니다.
 * `apply`가 false이면 바뀔 내용만 돌려줍니다.
 */
export async function rollbackUser(stores: CardStores, username: string, now: Date, apply: boolean): Promise<RollbackPlan> {
  const key = userKey(username);
  const stored = await readManifest(stores.privateStore, key, signal());
  if (stored === null) throw new Error("No published manifest to roll back.");
  const next = rolledBackManifest(stored.manifest, now);
  if (next === null) throw new Error("No previous release to roll back to.");
  const checkpoint = await new ObjectCheckpointStore(stores.privateStore).load(key, signal());
  const lease = checkpoint === null ? null : readCheckpoint(checkpoint.value, key)?.lease ?? null;
  if (lease !== null && Date.parse(lease.expiresAt) > now.getTime()) {
    throw new Error("A collection is running for this user; try again after it finishes.");
  }
  const plan: RollbackPlan = {
    from: { version: stored.manifest.current.version, generatedAt: stored.manifest.current.generatedAt },
    to: { version: next.current.version, generatedAt: next.current.generatedAt },
    checkpoint: checkpoint !== null,
  };
  if (!apply) return plan;
  await stores.privateStore.delete([checkpointPathname(key)]);
  if (!(await replaceManifest(stores.privateStore, next, stored))) {
    throw new Error(
      "Manifest changed during rollback; the checkpoint was already deleted. Run rollback without --yes to review the new target first.",
    );
  }
  return plan;
}
