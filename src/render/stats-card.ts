import { CARD_COLORS, STATS_CARD } from "../config.js";
import type { StatsSnapshot } from "../model.js";
import { renderActivityGrid } from "./activity-grid.js";
import { renderFrame, renderFrameDefs, steppedPath } from "./frame.js";
import { renderCalendar, renderMetricIcon, type MetricIcon } from "./icons.js";
import { renderPixelHeading } from "./pixel-heading.js";
import { renderMascot } from "./mascot.js";
import { escapeXml, formatCount, formatDate, renderFontStyles } from "./shared.js";

function renderMetric(label: string, value: number, icon: MetricIcon, x: number, width: number, accent: string): string {
  const textX = x + 65;
  const formatted = icon === "repository" ? String(value).padStart(2, "0") : formatCount(value);
  const numberSize = formatted.length > 5 ? 39 : 51;
  return `<g>
${renderMetricIcon(icon, x + 12, 141, accent)}
<text x="${textX}" y="181" font-size="${numberSize}" font-weight="700" stroke="${CARD_COLORS.ink}" stroke-width="1">${formatted}</text>
<text x="${textX + Math.floor((width - 65) / 2)}" y="205" text-anchor="middle" font-size="16" class="muted">${label}</text>
</g>`;
}

export function renderStatsCard(snapshot: StatsSnapshot): string {
  const { width, height } = STATS_CARD;
  const description = `${snapshot.period.label}: ${formatCount(snapshot.stats.commits)} commits, ${formatCount(snapshot.stats.publicRepositories)} public repositories, and ${formatCount(snapshot.stats.stars)} stars. Daily activity is grouped by UTC author date. Updated ${formatDate(snapshot.generatedAt)}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="stats-title stats-desc" shape-rendering="crispEdges">
<title id="stats-title">${escapeXml(snapshot.username)} GitHub activity</title>
<desc id="stats-desc">${escapeXml(description)}</desc>
<defs>${renderFontStyles()}${renderFrameDefs(width, height)}</defs>
${renderFrame(width, height)}
<g clip-path="url(#panel-clip)">
<rect x="6" y="6" width="558" height="288" fill="url(#panel-fill)"/>
${renderPixelHeading(snapshot.username, 20, 27)}
<text x="21" y="108" font-size="20" font-weight="700">SeongHwan · <tspan class="muted">GitHub activity</tspan></text>
${renderMascot(414, 20)}
<path d="M515 6V120M6 120H564M201 120V225M394 120V225" stroke="${CARD_COLORS.grid}" stroke-width="1" fill="none"/>
<g aria-hidden="true">
<rect x="529" y="40" width="8" height="8" fill="${CARD_COLORS.cyan}"/>
<rect x="550" y="54" width="8" height="8" fill="${CARD_COLORS.cyan}"/>
<rect x="538" y="67" width="8" height="8" fill="${CARD_COLORS.muted}"/>
<rect x="524" y="79" width="8" height="8" fill="${CARD_COLORS.lime}"/>
<rect x="541" y="93" width="8" height="8" fill="${CARD_COLORS.muted}"/>
</g>
${renderMetric("COMMITS", snapshot.stats.commits, "commit", 10, 183, CARD_COLORS.lime)}
${renderMetric("PUBLIC REPOS", snapshot.stats.publicRepositories, "repository", 208, 178, CARD_COLORS.cyan)}
${renderMetric("STARS", snapshot.stats.stars, "star", 402, 151, CARD_COLORS.peach)}
<rect x="0" y="225" width="570" height="75" fill="url(#dark-fill)"/>
<text x="22" y="246" font-size="15" class="on-dark" letter-spacing="1">LAST 12 MONTHS</text>
${renderActivityGrid(snapshot)}
<path d="M394 239V286" stroke="${CARD_COLORS.cyan}" stroke-width="1"/>
<rect x="418" y="259" width="6" height="6" fill="${CARD_COLORS.lime}"/>
<rect x="406" y="271" width="6" height="6" fill="${CARD_COLORS.cyan}"/>
<g transform="translate(435 244)">
<path d="${steppedPath(119, 37)}" fill="${CARD_COLORS.lime}"/>
${renderCalendar(9, 8)}
<text x="36" y="16" font-size="11" font-weight="700">UPDATED</text>
<text x="36" y="28" font-size="11">${formatDate(snapshot.generatedAt)}</text>
</g>
</g>
</svg>`;
}
