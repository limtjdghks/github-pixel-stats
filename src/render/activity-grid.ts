import { CARD_COLORS } from "../config.js";
import type { StatsSnapshot } from "../model.js";

const ACTIVITY_COLORS = ["#64829F", "#5DAA9E", "#71C5A8", "#8AE5B6", CARD_COLORS.lime];

export function renderActivityGrid(snapshot: StatsSnapshot): string {
  const days = snapshot.activity.days;
  const startDay = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay();
  const columns = Math.ceil((startDay + days.length) / 7);
  const columnSpacing = columns > 53 ? 6 : 7;
  const maximum = Math.max(1, ...days.map((day) => day.commits));
  const cells = days.map((day, index) => {
    const position = startDay + index;
    const x = 22 + Math.floor(position / 7) * columnSpacing;
    const y = 255 + (position % 7) * 5;
    const level = day.commits === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(day.commits / maximum) * 4)));
    return `<rect data-activity-date="${day.date}" data-activity-count="${day.commits}" x="${x}" y="${y}" width="5" height="4" fill="${ACTIVITY_COLORS[level]}"><title>${day.date}: ${day.commits} commits</title></rect>`;
  });
  return `<g aria-label="Daily commits in UTC">${cells.join("")}</g>`;
}
