import { CARD_COLORS } from "../config.js";

const GLYPHS: Record<string, string[]> = {
  L: ["110000", "110000", "110000", "110000", "110000", "110000", "110000", "111111", "111111"],
  I: ["11", "11", "11", "11", "11", "11", "11", "11", "11"],
  M: ["1100011", "1110111", "1111111", "1101011", "1100011", "1100011", "1100011", "1100011", "1100011"],
  T: ["111111", "111111", "001100", "001100", "001100", "001100", "001100", "001100", "001100"],
  J: ["001111", "001111", "000011", "000011", "000011", "000011", "110011", "111111", "011110"],
  D: ["111100", "111110", "110111", "110011", "110011", "110011", "110111", "111110", "111100"],
  G: ["011110", "111111", "110000", "110000", "110111", "110111", "110011", "111111", "011110"],
  H: ["110011", "110011", "110011", "111111", "111111", "110011", "110011", "110011", "110011"],
  K: ["110011", "110011", "110110", "111100", "111100", "110110", "110110", "110011", "110011"],
  S: ["011110", "111111", "110000", "111000", "011110", "000111", "000011", "111111", "011110"],
};

export function renderPixelHeading(value: string, x: number, y: number): string {
  let offset = x;
  const paths = [...value.toUpperCase()].map((letter) => {
    const glyph = GLYPHS[letter];
    if (!glyph) throw new Error(`Unsupported pixel heading glyph: ${letter}`);
    const rows = glyph.map((row, index) => {
      const runs = [...row.matchAll(/1+/g)];
      return runs.map((run) => `M${offset + run.index * 6} ${y + index * 6}h${run[0].length * 6}v6h-${run[0].length * 6}Z`).join("");
    }).join("");
    offset += glyph[0]!.length * 6 + 4;
    return rows;
  }).join("");
  return `<path aria-hidden="true" d="${paths}" fill="${CARD_COLORS.ink}"/>`;
}
