import { CARD_COLORS } from "../config.js";

export function renderMascot(x: number, y: number): string {
  return `<g transform="translate(${x} ${y})" aria-hidden="true">
  <rect x="8" y="0" width="40" height="4" fill="${CARD_COLORS.grid}"/>
  <rect x="4" y="4" width="48" height="8" fill="${CARD_COLORS.grid}"/>
  <rect x="0" y="12" width="56" height="36" fill="${CARD_COLORS.grid}"/>
  <rect x="4" y="8" width="48" height="36" fill="${CARD_COLORS.violet}"/>
  <rect x="12" y="12" width="32" height="28" fill="${CARD_COLORS.peach}"/>
  <rect x="12" y="12" width="32" height="8" fill="${CARD_COLORS.ink}"/>
  <rect x="8" y="16" width="8" height="16" fill="${CARD_COLORS.ink}"/>
  <rect x="40" y="16" width="8" height="16" fill="${CARD_COLORS.ink}"/>
  <rect x="16" y="24" width="4" height="4" fill="${CARD_COLORS.ink}"/>
  <rect x="36" y="24" width="4" height="4" fill="${CARD_COLORS.ink}"/>
  <rect x="24" y="32" width="8" height="4" fill="${CARD_COLORS.grid}"/>
  <rect x="4" y="44" width="48" height="8" fill="${CARD_COLORS.ink}"/>
  <rect x="12" y="48" width="32" height="8" fill="${CARD_COLORS.cyan}"/>
  <rect x="20" y="48" width="4" height="4" fill="${CARD_COLORS.ink}"/>
  <rect x="32" y="48" width="4" height="4" fill="${CARD_COLORS.ink}"/>
  <rect x="24" y="52" width="8" height="4" fill="${CARD_COLORS.lime}"/>
</g>`;
}
