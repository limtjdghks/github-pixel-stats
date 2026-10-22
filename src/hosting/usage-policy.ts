import type { BlobOperationCount } from "../storage/operation-count.js";
import type { DailyUsage } from "../storage/usage.js";

/**
 * Cron과 bootstrap이 UTC 하루 동안 쓸 수 있는 Blob Advanced Operation 수입니다.
 * Hobby 포함량은 월 2,000회(하루 약 64회)이고 넘으면 30일 동안 Blob을 쓸 수 없으므로, 대시보드 탐색과 운영 작업 몫을 남겨 둡니다.
 */
export const DAILY_ADVANCED_BUDGET = 60;
/**
 * 그중 bootstrap이 쓸 수 있는 몫입니다(발행까지 끝나는 bootstrap 약 2회분). 발행 전 사용자의 카드 조회가 bootstrap을
 * 반복해도 발행 사용자의 Cron 갱신 예산을 모두 쓰지 않게 합니다. 몫을 다 쓴 날의 미발행 사용자는 Cron이 이어서 수집합니다.
 */
export const BOOTSTRAP_DAILY_ADVANCED_BUDGET = 26;
/**
 * 발행까지 끝나는 job 하나의 Advanced Operation 추정치입니다. 등록 1회, checkpoint lease·진행·완료 저장 2~3회,
 * 발행 쓰기 5회(snapshot·state·카드 2개·manifest), 정리 list 2회를 더한 값입니다.
 * 남은 예산이 이보다 적으면 job을 시작하지 않으며, 실제 job이 이보다 많이 쓰면 예산을 조금 넘을 수 있습니다.
 */
export const JOB_ADVANCED_ESTIMATE = 12;
/**
 * 사용량 기록 자체의 작업입니다. 시작할 때 읽기 1회와 갱신 안의 읽기·쓰기 1회씩이며,
 * 다른 실행과 충돌해 다시 시도한 작업은 세지 않습니다.
 */
export const USAGE_RECORD_OPERATIONS: BlobOperationCount = { advanced: 1, simple: 2 };
/** 사용량 기록을 보존하는 일수와, Cron이 보존 기간 뒤 한 번에 지우는 일수입니다. */
export const USAGE_RETENTION_DAYS = 90;
export const USAGE_SWEEP_DAYS = 7;

/** Cron 한 실행이 이번 사용량 기록 쓰기를 빼고 더 쓸 수 있는 Advanced Operation 수입니다. */
export function cronAdvancedAllowance(usage: DailyUsage): number {
  return Math.max(0, DAILY_ADVANCED_BUDGET - usage.blob.advanced - USAGE_RECORD_OPERATIONS.advanced);
}

/** 전체 예산과 bootstrap 몫에 job 하나와 사용량 기록 쓰기가 들어갈 여유가 있는지 판단합니다. */
export function bootstrapAllowed(usage: DailyUsage): boolean {
  const needed = JOB_ADVANCED_ESTIMATE + USAGE_RECORD_OPERATIONS.advanced;
  return usage.bootstrap.advanced + needed <= BOOTSTRAP_DAILY_ADVANCED_BUDGET &&
    usage.blob.advanced + needed <= DAILY_ADVANCED_BUDGET;
}

export interface CronUsage {
  operations: BlobOperationCount;
  processed: number;
  published: number;
  requests: number;
  errors: number;
}

export interface BootstrapUsage {
  operations: BlobOperationCount;
  published: boolean;
  requests: number;
}

function addOperations(usage: DailyUsage, operations: BlobOperationCount): DailyUsage["blob"] {
  return {
    advanced: usage.blob.advanced + operations.advanced + USAGE_RECORD_OPERATIONS.advanced,
    simple: usage.blob.simple + operations.simple + USAGE_RECORD_OPERATIONS.simple,
  };
}

/** Cron 한 실행을 기록에 더합니다. 이 기록 쓰기의 작업도 함께 더합니다. */
export function addCronUsage(usage: DailyUsage, run: CronUsage): DailyUsage {
  return {
    ...usage,
    blob: addOperations(usage, run.operations),
    cron: {
      runs: usage.cron.runs + 1,
      processed: usage.cron.processed + run.processed,
      published: usage.cron.published + run.published,
      requests: usage.cron.requests + run.requests,
      errors: usage.cron.errors + run.errors,
    },
  };
}

/** bootstrap 한 실행을 기록에 더합니다. 이 기록 쓰기의 작업도 bootstrap 몫에 함께 더합니다. */
export function addBootstrapUsage(usage: DailyUsage, run: BootstrapUsage): DailyUsage {
  return {
    ...usage,
    blob: addOperations(usage, run.operations),
    bootstrap: {
      runs: usage.bootstrap.runs + 1,
      published: usage.bootstrap.published + (run.published ? 1 : 0),
      requests: usage.bootstrap.requests + run.requests,
      advanced: usage.bootstrap.advanced + run.operations.advanced + USAGE_RECORD_OPERATIONS.advanced,
    },
  };
}
