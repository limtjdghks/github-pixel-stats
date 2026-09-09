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
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;padding:32px}
    main{width:min(100%,880px)}
    h1{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .cards{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap}
    img{display:block;max-width:100%;height:auto}
  </style>
</head>
<body>
  <main>
    <h1>GitHub Pixel Stats Preview</h1>
    <div class="cards">
      <img src="./stats.svg" width="500" height="230" alt="${escapeXml(statsAlt)}" role="img">
      <img src="./languages.svg" width="340" height="230" alt="${escapeXml(languagesAlt)}" role="img">
    </div>
  </main>
</body>
</html>`;
}
