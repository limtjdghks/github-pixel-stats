import type { CachedCommit, DailyActivity } from "../model.js";

const DAY_MILLISECONDS = 86_400_000;

export function aggregateActivity(commits: CachedCommit[], from: string, to: string): DailyActivity {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error("Activity period is invalid.");
  }
  const firstDay = Math.floor(start / DAY_MILLISECONDS) * DAY_MILLISECONDS;
  const lastDay = Math.floor(end / DAY_MILLISECONDS) * DAY_MILLISECONDS;
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const authoredAt = Date.parse(commit.authoredAt);
    if (!Number.isFinite(authoredAt) || authoredAt < start || authoredAt > end) {
      throw new Error("Activity commit is outside the collection period.");
    }
    const date = new Date(authoredAt).toISOString().slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days: DailyActivity["days"] = [];
  for (let timestamp = firstDay; timestamp <= lastDay; timestamp += DAY_MILLISECONDS) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    days.push({ date, commits: counts.get(date) ?? 0 });
  }
  return { timezone: "UTC", days };
}
