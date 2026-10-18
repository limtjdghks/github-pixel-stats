import { renderMascot } from "./mascot.js";

export type MascotRenderer = (x: number, y: number) => string;

const mascotRenderers = {
  cat: renderMascot,
} satisfies Record<string, MascotRenderer>;

export type MascotId = keyof typeof mascotRenderers;

export const DEFAULT_MASCOT_ID: MascotId = "cat";

export const MASCOT_IDS = Object.keys(mascotRenderers) as MascotId[];

export function isMascotId(raw: unknown): raw is MascotId {
  return typeof raw === "string" && Object.hasOwn(mascotRenderers, raw);
}

export function resolveMascotId(raw: string | null | undefined): MascotId {
  return raw !== null && raw !== undefined && Object.hasOwn(mascotRenderers, raw)
    ? raw as MascotId
    : DEFAULT_MASCOT_ID;
}

export function getMascotRenderer(id: MascotId): MascotRenderer {
  return mascotRenderers[id];
}
