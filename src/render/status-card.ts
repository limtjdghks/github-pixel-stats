import { LANGUAGES_CARD, STATS_CARD } from "../config.js";
import { renderFrame, renderFrameDefs } from "./frame.js";
import { escapeXml, renderFontStyles } from "./shared.js";

export type CardStatus = "pending" | "invalid-username" | "unavailable";

const STATUS_TEXT: Record<CardStatus, { heading: string; lines: [string, string] }> = {
  pending: { heading: "PREPARING", lines: ["Stats are not ready yet.", "Check back after an update."] },
  "invalid-username": { heading: "INVALID USER", lines: ["Use a GitHub username", "in the card URL."] },
  unavailable: { heading: "UNAVAILABLE", lines: ["Stats are temporarily", "unavailable."] },
};

/**
 * 발행된 카드 대신 응답하는 상태 카드입니다. README 배치가 바뀌지 않도록 요청한 카드와 같은 크기로 그립니다.
 * 요청 입력값을 넣지 않으므로 같은 상태·크기의 카드는 사용자와 관계없이 항상 같은 내용입니다.
 */
export function renderStatusCard(status: CardStatus, card: "stats" | "languages"): string {
  const { width, height } = card === "stats" ? STATS_CARD : LANGUAGES_CARD;
  const { heading, lines } = STATUS_TEXT[status];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="status-title status-desc" shape-rendering="crispEdges">
<title id="status-title">GitHub Pixel Stats: ${escapeXml(heading.toLowerCase())}</title>
<desc id="status-desc">${escapeXml(lines.join(" "))}</desc>
<defs>${renderFontStyles()}${renderFrameDefs(width, height)}</defs>
${renderFrame(width, height)}
<g clip-path="url(#panel-clip)">
<rect x="6" y="6" width="${width - 12}" height="${height - 12}" fill="url(#panel-fill)"/>
<text x="20" y="90" font-size="44">${escapeXml(heading)}</text>
<text x="21" y="140" font-size="18" class="muted">${escapeXml(lines[0])}</text>
<text x="21" y="166" font-size="18" class="muted">${escapeXml(lines[1])}</text>
<rect x="0" y="225" width="${width}" height="75" fill="url(#dark-fill)"/>
<text x="22" y="268" font-size="15" class="on-dark" letter-spacing="1">GITHUB PIXEL STATS</text>
</g>
</svg>`;
}
