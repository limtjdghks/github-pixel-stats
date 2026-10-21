import type { ObjectEntry } from "../storage/object-store.js";
import { CHECKPOINT_PREFIX, MANIFEST_PREFIX, userKeyFromPathname } from "../storage/pathnames.js";

/**
 * 발행 후 다시 수집할 때까지의 간격입니다.
 * 하루 1회 Cron이 전날 같은 시각 무렵 발행한 사용자를 놓치지 않도록 24시간보다 짧게 둡니다.
 */
export const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * private store 목록만으로 이번 갱신 대상 사용자 key를 고릅니다. 객체 본문은 읽지 않습니다.
 * manifest `uploadedAt`이 `REFRESH_INTERVAL_MS` 이상 지난 발행 사용자를 오래된 순으로 먼저,
 * 그다음 manifest가 없는(bootstrap이 끝나지 않은) 사용자를 반환합니다.
 * 미발행 사용자를 뒤에 두는 이유는 카드 URL만으로 생긴, 실패를 반복하는 checkpoint가
 * 예산을 먼저 써서 이미 카드를 쓰는 사용자의 갱신을 막지 않게 하기 위해서입니다.
 */
export function selectDueUsers(
  checkpoints: readonly ObjectEntry[],
  manifests: readonly ObjectEntry[],
  now: Date,
): string[] {
  const published = new Map<string, number>();
  for (const entry of manifests) {
    const key = userKeyFromPathname(MANIFEST_PREFIX, entry.pathname);
    if (key !== null) published.set(key, entry.uploadedAt.getTime());
  }
  const pending = new Set<string>();
  for (const entry of checkpoints) {
    const key = userKeyFromPathname(CHECKPOINT_PREFIX, entry.pathname);
    if (key !== null && !published.has(key)) pending.add(key);
  }
  const cutoff = now.getTime() - REFRESH_INTERVAL_MS;
  const due = [...published]
    .filter(([, uploadedAt]) => uploadedAt <= cutoff)
    .sort(([leftKey, left], [rightKey, right]) => left - right || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
  return [...due, ...[...pending].sort()];
}
