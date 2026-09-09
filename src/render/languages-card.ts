import { CARD_COLORS, LANGUAGE_BAR_SEGMENTS, LANGUAGES_CARD } from "../config.js";
import type { LanguageStat, StatsSnapshot } from "../model.js";
import { renderFrame, renderFrameDefs } from "./frame.js";
import { escapeXml, formatCount, normalizeColor, renderFontStyles } from "./shared.js";

function renderLanguage(language: LanguageStat, index: number): string {
  const y = 48 + index * 47;
  const color = normalizeColor(language.color);
  const segments = Array.from({ length: LANGUAGE_BAR_SEGMENTS }, (_, segment) =>
    `<rect data-language-segment="true" x="${196 + segment * 7}" y="${y + 17}" width="5" height="15" fill="${segment < language.filledSegments ? color : CARD_COLORS.track}"/>`,
  ).join("");
  const fontSize = language.name.length > 12 ? 12 : 17;
  return `<g>
<text x="16" y="${y + 31}" font-size="19" font-weight="700">${String(index + 1).padStart(2, "0")}</text>
<rect x="51" y="${y + 14}" width="20" height="20" fill="${color}"/>
<text x="87" y="${y + 31}" font-size="${fontSize}" font-weight="700">${escapeXml(language.name)}</text>
${segments}
</g>`;
}

export function renderLanguagesCard(snapshot: StatsSnapshot): string {
  const { width, height } = LANGUAGES_CARD;
  const description = snapshot.languages.length
    ? snapshot.languages.map((language, index) => `${index + 1}. ${language.name}: ${formatCount(language.commitCount)} commits (${(language.share * 100).toFixed(2)}% of the top languages)`).join("; ")
    : "No language data is available for the selected period.";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="languages-title languages-desc" shape-rendering="crispEdges">
<title id="languages-title">${escapeXml(snapshot.username)} most committed languages</title>
<desc id="languages-desc">${escapeXml(snapshot.period.label)}. ${escapeXml(description)}</desc>
<defs>${renderFontStyles()}${renderFrameDefs(width, height)}</defs>
${renderFrame(width, height)}
<g clip-path="url(#panel-clip)">
<rect x="6" y="6" width="343" height="288" fill="url(#panel-fill)"/>
<rect x="0" y="0" width="355" height="48" fill="url(#dark-fill)"/>
<g fill="${CARD_COLORS.cyan}" aria-hidden="true"><rect x="17" y="29" width="6" height="7"/><rect x="25" y="19" width="6" height="17"/><rect x="33" y="26" width="6" height="10"/></g>
<text x="51" y="33" font-size="16" textLength="243" lengthAdjust="spacingAndGlyphs" font-weight="700" class="light">MOST COMMITTED LANGUAGES</text>
<path transform="translate(312 19)" d="M6 3H9V6H6V9H3V12H6V15H9V18H6V15H3V12H0V9H3V6H6ZM18 0H21V6H18V12H15V18H12V12H15V6H18ZM24 3H27V6H30V9H33V12H30V15H27V18H24V15H27V12H30V9H27V6H24Z" fill="${CARD_COLORS.cyan}"/>
${[95, 142, 189, 236].map((y) => `<path d="M6 ${y}H349" stroke="${CARD_COLORS.grid}" stroke-width="1"/>`).join("")}
${snapshot.languages.length ? snapshot.languages.map(renderLanguage).join("") : '<text x="28" y="164" font-size="20">NO LANGUAGE DATA YET</text>'}
</g>
</svg>`;
}
