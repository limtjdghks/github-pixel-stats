import { readFileSync } from "node:fs";
import { CARD_COLORS } from "../config.js";

const pixelFont = readFileSync(new URL("../../assets/fonts/NeoDunggeunmoPro.woff2", import.meta.url)).toString("base64");

export function renderFontStyles(): string {
  return `<style>
@font-face{font-family:"NeoDunggeunmo Pro";src:url("data:font/woff2;base64,${pixelFont}") format("woff2");font-style:normal;font-weight:400;font-display:block}
text{font-family:"NeoDunggeunmo Pro",monospace;font-weight:400;font-synthesis:none;fill:${CARD_COLORS.ink}}
.on-dark{fill:${CARD_COLORS.cyan}}
.muted{fill:${CARD_COLORS.muted}}
.light{fill:${CARD_COLORS.panel}}
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
