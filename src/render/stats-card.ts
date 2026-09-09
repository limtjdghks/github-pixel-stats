import { CARD_COLORS, STATS_CARD } from "../config.js";
import type { StatsSnapshot } from "../model.js";
import { renderMascot } from "./mascot.js";
import { escapeXml, formatCount, formatDate, renderFontStyles } from "./shared.js";

interface Metric {
  label: string;
  value: number;
  accent: string;
}

function renderMetric(metric: Metric, index: number): string {
  const x = index * 166 + 18;

  return `<g>
  <rect x="${index * 166}" y="82" width="${index === 2 ? 168 : 166}" height="98" fill="${CARD_COLORS.panel}"/>
  <rect x="${x}" y="100" width="10" height="10" fill="${metric.accent}"/>
  <text x="${x + 16}" y="110" font-size="12" letter-spacing="1">${metric.label}</text>
  <text x="${x}" y="153" font-size="31" font-weight="700">${formatCount(metric.value)}</text>
</g>`;
}

export function renderStatsCard(snapshot: StatsSnapshot): string {
  const metrics: Metric[] = [
    { label: "COMMITS", value: snapshot.stats.commits, accent: CARD_COLORS.lime },
    { label: "PUBLIC REPOS", value: snapshot.stats.publicRepositories, accent: CARD_COLORS.cyan },
    { label: "STARS", value: snapshot.stats.stars, accent: CARD_COLORS.peach },
  ];
  const title = `${snapshot.username} GitHub activity`;
  const description = `${snapshot.period.label}: ${formatCount(snapshot.stats.commits)} commits, ${formatCount(snapshot.stats.publicRepositories)} public repositories, and ${formatCount(snapshot.stats.stars)} stars. Updated ${formatDate(snapshot.generatedAt)}.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STATS_CARD.width}" height="${STATS_CARD.height}" viewBox="0 0 ${STATS_CARD.width} ${STATS_CARD.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="stats-title stats-desc" shape-rendering="crispEdges">
<title id="stats-title">${escapeXml(title)}</title>
<desc id="stats-desc">${escapeXml(description)}</desc>
<defs>${renderFontStyles()}</defs>
<rect x="1" y="1" width="498" height="228" fill="${CARD_COLORS.canvas}" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
<rect x="1" y="1" width="498" height="81" fill="${CARD_COLORS.canvas}"/>
<text x="18" y="38" font-size="33" font-weight="700" letter-spacing="1">${escapeXml(snapshot.username.toUpperCase())}</text>
<text x="19" y="62" font-size="13" letter-spacing="1">GITHUB ACTIVITY</text>
${renderMascot(426, 12)}
<line x1="1" y1="82" x2="499" y2="82" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
${metrics.map(renderMetric).join("\n")}
<line x1="166" y1="82" x2="166" y2="180" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
<line x1="332" y1="82" x2="332" y2="180" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
<line x1="1" y1="180" x2="499" y2="180" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
<rect x="1" y="181" width="498" height="48" fill="${CARD_COLORS.ink}"/>
<text class="on-dark" x="18" y="210" font-size="12" letter-spacing="1">${escapeXml(snapshot.period.label.toUpperCase())}</text>
<rect x="288" y="195" width="8" height="8" fill="${CARD_COLORS.lime}"/>
<text class="on-dark" x="306" y="210" font-size="12" letter-spacing="1">UPDATED ${formatDate(snapshot.generatedAt)}</text>
</svg>`;
}
