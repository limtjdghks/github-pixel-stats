/**
 * background 작업이 쓸 deadline을 정합니다.
 * `now + budgetMs`와 Function 종료 시각(`invocationDeadline - marginMs`) 중 이른 쪽이며,
 * runtime이 종료 시각을 알려 주지 않으면(Vercel 밖 실행) `budgetMs`만 적용합니다.
 */
export function boundedDeadline(
  now: Date,
  budgetMs: number,
  invocationDeadline: Date | undefined,
  marginMs: number,
): Date {
  const budget = now.getTime() + budgetMs;
  return new Date(invocationDeadline === undefined ? budget : Math.min(budget, invocationDeadline.getTime() - marginMs));
}
