import { CARD_COLORS } from "../config.js";

export type MetricIcon = "commit" | "repository" | "star";

const paths: Record<MetricIcon, string> = {
  commit: "M8 1H14V4H8ZM8 19H14V22H8ZM1 8H4V15H1ZM19 8H22V15H19ZM4 4H7V7H4ZM16 4H19V7H16ZM4 16H7V19H4ZM16 16H19V19H16ZM8 7H15V10H18V15H15V18H8V15H5V10H8ZM9 10V15H14V10Z",
  repository: "M3 1H20V3H22V18H20V22H3V18H1V3H3ZM4 4V15H19V4ZM5 18V20H8V18ZM11 18V20H16V18Z",
  star: "M10 1H13V6H16V9H22V12H17V15H19V21H16V18H13V16H10V18H7V21H4V15H6V12H1V9H7V6H10ZM10 10V13H13V10Z",
};

export function renderMetricIcon(kind: MetricIcon, x: number, y: number, color: string): string {
  const path = paths[kind].replace(/\d+/g, (coordinate) => String(Math.round(Number(coordinate) * 1.3)));
  return `<g transform="translate(${x} ${y})" aria-hidden="true">
<path d="M4 0H40V4H44V40H40V44H4V40H0V4H4Z" fill="${color}"/>
<path transform="translate(7 7)" d="${path}" fill="${CARD_COLORS.ink}" fill-rule="evenodd"/>
</g>`;
}

export function renderCalendar(x: number, y: number): string {
  return `<path transform="translate(${x} ${y})" d="M2 2H5V0H7V2H14V0H16V2H19V20H1V2ZM3 7V18H17V7ZM7 10H10V8H13V11H11V13H9V15H6V12H7Z" fill="${CARD_COLORS.ink}" fill-rule="evenodd"/>`;
}
