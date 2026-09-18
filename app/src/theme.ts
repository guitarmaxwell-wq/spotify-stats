export const theme = {
  room: '#1a1410',
  roomDeep: '#0f0b08',
  wood: '#6b4526',
  woodLight: '#8a5c33',
  woodDark: '#3f2715',
  woodEdge: '#2a1a0d',
  crate: '#2f6f63',
  crateLight: '#3d8a7b',
  crateDark: '#1e4a42',
  ink: '#f4ece0',
  inkDim: '#b6a691',
  inkFaint: '#7c6d5c',
  gold: '#e3b23c',
  card: '#241b14',
  cardEdge: '#3a2c20',
};

/** Deterministic hash of an album id -> stable sleeve colors. */
export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const SLEEVE_HUES = [4, 18, 32, 46, 120, 160, 190, 212, 246, 275, 310, 340];

export interface SleevePalette {
  base: string;
  deep: string;
  accent: string;
  text: string;
}

export function sleevePalette(id: string): SleevePalette {
  const h = hashId(id);
  const hue = SLEEVE_HUES[h % SLEEVE_HUES.length];
  const sat = 32 + (h >> 4) % 28;
  const light = 26 + (h >> 9) % 16;
  return {
    base: `hsl(${hue}, ${sat}%, ${light}%)`,
    deep: `hsl(${hue}, ${sat + 6}%, ${Math.max(8, light - 13)}%)`,
    accent: `hsl(${(hue + 36) % 360}, ${Math.min(80, sat + 30)}%, ${light + 34}%)`,
    text: `hsl(${hue}, 22%, 92%)`,
  };
}
