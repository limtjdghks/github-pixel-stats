import {
  CARD_COLORS,
  LANGUAGE_BAR_SEGMENTS,
  LANGUAGES_CARD,
} from "../config.js";
import type { LanguageStat, StatsSnapshot } from "../model.js";
import { escapeXml, formatCount, normalizeColor, renderFontStyles } from "./shared.js";

const BAR_X = 170;
const BAR_SEGMENT_WIDTH = 6;
const BAR_SEGMENT_GAP = 2;

function renderSegments(language: LanguageStat, y: number): string {
  const filledSegments = Math.min(
    LANGUAGE_BAR_SEGMENTS,
    Math.max(0, Math.round(language.filledSegments)),
  );
  const color = normalizeColor(language.color);

  return Array.from({ length: LANGUAGE_BAR_SEGMENTS }, (_, index) => {
    const x = BAR_X + index * (BAR_SEGMENT_WIDTH + BAR_SEGMENT_GAP);
    const fill = index < filledSegments ? color : CARD_COLORS.panel;

    return `<rect x="${x}" y="${y}" width="${BAR_SEGMENT_WIDTH}" height="10" fill="${fill}"/>`;
  }).join("");
}

function languageFontSize(name: string): number {
  if (name.length > 16) return 9;
  if (name.length > 12) return 10;
  return 12;
}

function renderLanguage(language: LanguageStat, index: number): string {
  const rowY = 48 + index * 36;
  const baseline = rowY + 23;
  const rank = String(index + 1).padStart(2, "0");
  const color = normalizeColor(language.color);

  return `<g>
  <rect x="1" y="${rowY}" width="338" height="36" fill="${index % 2 === 0 ? CARD_COLORS.canvas : CARD_COLORS.panel}"/>
  <text x="14" y="${baseline}" font-size="12" font-weight="700">${rank}</text>
  <rect x="43" y="${baseline - 9}" width="10" height="10" fill="${color}"/>
  <text x="62" y="${baseline}" font-size="${languageFontSize(language.name)}" font-weight="700">${escapeXml(language.name)}</text>
  ${renderSegments(language, baseline - 9)}
</g>`;
}

function renderEmptyState(): string {
  return `<g>
  <rect x="1" y="48" width="338" height="181" fill="${CARD_COLORS.panel}"/>
  <rect x="28" y="89" width="12" height="12" fill="${CARD_COLORS.lime}"/>
  <rect x="44" y="89" width="12" height="12" fill="${CARD_COLORS.cyan}"/>
  <rect x="60" y="89" width="12" height="12" fill="${CARD_COLORS.peach}"/>
  <text x="28" y="137" font-size="17" font-weight="700">NO LANGUAGE DATA</text>
  <text x="28" y="162" font-size="12" letter-spacing="1">CHECK BACK AFTER THE NEXT RUN</text>
</g>`;
}

export function renderLanguagesCard(snapshot: StatsSnapshot): string {
  const languages = snapshot.languages.slice(0, 5);
  const title = `${snapshot.username} most committed languages`;
  const languageDescription = languages.length === 0
    ? "No language data is available for the selected period."
    : languages
        .map(
          (language, index) =>
            `${index + 1}. ${language.name}: ${formatCount(language.commitCount)} commits`,
        )
        .join("; ");
  const description = `${snapshot.period.label}. ${languageDescription}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LANGUAGES_CARD.width}" height="${LANGUAGES_CARD.height}" viewBox="0 0 ${LANGUAGES_CARD.width} ${LANGUAGES_CARD.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="languages-title languages-desc" shape-rendering="crispEdges">
<title id="languages-title">${escapeXml(title)}</title>
<desc id="languages-desc">${escapeXml(description)}</desc>
<defs>${renderFontStyles()}</defs>
<rect x="1" y="1" width="338" height="228" fill="${CARD_COLORS.canvas}" stroke="${CARD_COLORS.grid}" stroke-width="2"/>
<rect x="1" y="1" width="338" height="47" fill="${CARD_COLORS.ink}"/>
<rect x="14" y="17" width="10" height="10" fill="${CARD_COLORS.lime}"/>
<text class="on-dark" x="34" y="29" font-size="14" font-weight="700" letter-spacing="1">MOST COMMITTED LANGUAGES</text>
${languages.length === 0 ? renderEmptyState() : languages.map(renderLanguage).join("\n")}
${languages.length > 0 ? [84, 120, 156, 192].map((y) => `<line x1="1" y1="${y}" x2="339" y2="${y}" stroke="${CARD_COLORS.grid}" stroke-width="1"/>`).join("\n") : ""}
</svg>`;
}
