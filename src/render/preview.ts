import { STATS_CARD, LANGUAGES_CARD, CARD_COLORS } from "../config.js";
import { escapeXml } from "./shared.js";

function decodeDescription(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function extractDescription(svg: string, fallback: string): string {
  const match = svg.match(/<desc\s+id="[^"]+">([\s\S]*?)<\/desc>/);
  return match?.[1] ? decodeDescription(match[1]) : fallback;
}

export function renderPreviewHtml(statsSvg: string, languagesSvg: string): string {
  const statsAlt = extractDescription(statsSvg, "limtjdghks GitHub activity statistics");
  const languagesAlt = extractDescription(
    languagesSvg,
    "limtjdghks most committed languages",
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub Pixel Stats Preview</title>
  <style>
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:${CARD_COLORS.canvas};padding:32px 16px}
    main{width:min(100%,950px)}
    h1{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .cards{display:grid;grid-template-columns:570fr 355fr;align-items:start;gap:12px}
    @media(max-width:700px){.cards{grid-template-columns:1fr;justify-items:center;gap:20px}}
    img{display:block;max-width:100%;height:auto}
  </style>
</head>
<body>
  <main>
    <h1>GitHub Pixel Stats Preview</h1>
    <div class="cards">
      <img src="./stats.svg" width="${STATS_CARD.width}" height="${STATS_CARD.height}" alt="${escapeXml(statsAlt)}" role="img">
      <img src="./languages.svg" width="${LANGUAGES_CARD.width}" height="${LANGUAGES_CARD.height}" alt="${escapeXml(languagesAlt)}" role="img">
    </div>
  </main>
</body>
</html>`;
}
