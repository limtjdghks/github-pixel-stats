import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { CARD_COLORS } from "../config.js";

const require = createRequire(import.meta.url);

function loadFont(weight: 400 | 700): string {
  const path = require.resolve(
    `@fontsource/pixelify-sans/files/pixelify-sans-latin-${weight}-normal.woff2`,
  );

  return readFileSync(path).toString("base64");
}

const regularFont = loadFont(400);
const boldFont = loadFont(700);

export function renderFontStyles(): string {
  return `<style>
@font-face{font-family:"Pixelify Sans";src:url("data:font/woff2;base64,${regularFont}") format("woff2");font-style:normal;font-weight:400;font-display:block}
@font-face{font-family:"Pixelify Sans";src:url("data:font/woff2;base64,${boldFont}") format("woff2");font-style:normal;font-weight:700;font-display:block}
text{font-family:"Pixelify Sans",monospace;fill:${CARD_COLORS.ink}}
.on-dark{fill:${CARD_COLORS.canvas}}
</style>`;
}

export function escapeXml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };

    return entities[character] ?? character;
  });
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.trunc(value)));
}

export function formatDate(value: string): string {
  const date = value.slice(0, 10);

  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replaceAll("-", ".") : "UNKNOWN";
}

export function normalizeColor(value: string): string {
  return /^#[\dA-Fa-f]{6}$/.test(value) ? value : CARD_COLORS.violet;
}
