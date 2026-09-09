import { CARD_COLORS } from "../config.js";

export function steppedPath(width: number, height: number, inset = 0): string {
  const right = width - inset;
  const bottom = height - inset;
  return `M${inset + 12} ${inset}H${right - 12}V${inset + 6}H${right - 6}V${inset + 12}H${right}V${bottom - 12}H${right - 6}V${bottom - 6}H${right - 12}V${bottom}H${inset + 12}V${bottom - 6}H${inset + 6}V${bottom - 12}H${inset}V${inset + 12}H${inset + 6}V${inset + 6}H${inset + 12}Z`;
}

export function renderFrameDefs(width: number, height: number): string {
  return `<clipPath id="panel-clip"><path d="${steppedPath(width, height, 6)}"/></clipPath>
<linearGradient id="panel-fill" x2="0" y2="1"><stop stop-color="#EFF7FF"/><stop offset="1" stop-color="${CARD_COLORS.panel}"/></linearGradient>
<linearGradient id="dark-fill" x2="0" y2="1"><stop stop-color="${CARD_COLORS.footer}"/><stop offset="1" stop-color="${CARD_COLORS.ink}"/></linearGradient>`;
}

export function renderFrame(width: number, height: number): string {
  return `<path d="${steppedPath(width, height)}" fill="${CARD_COLORS.grid}"/>
<path d="${steppedPath(width, height, 3)}" fill="${CARD_COLORS.ink}"/>`;
}
