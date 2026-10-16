/** Gameplay meanings stay the same under every environment theme. */
export const colors = {
  steel: 0x718174, dark: 0x1c2724, ivory: 0xcdd1c4,
  signal: 0xe4eb1c, amber: 0xd3ae79, red: 0xed8165, marker: 0xd4e0c3,
  oxygen: 0x64ced0, battery: 0xe4eb1c, repair: 0xe4a056,
  rescue: 0xe7b647, medical: 0xd98b63, visor: 0x8be1d8,
};

export const roomColors = [0xd3ae79, 0xa7b8a0, 0x97bfc0, 0xc1c48b];

export interface StationTheme {
  wallOuter: number; wallInner: number; capOuter: number; capInner: number;
  floorWall: number; floorNear: number; floorRadar: number; floorUnknown: number;
}

export const stationThemes = {
  industrial: {
    wallOuter: 0x35463d, wallInner: 0x4c5c51, capOuter: 0x8b9586, capInner: 0xb1b9aa,
    floorWall: 0x29352d, floorNear: 0x667064, floorRadar: 0x3e4b40, floorUnknown: 0x2c382f,
  },
  cold: {
    wallOuter: 0x354751, wallInner: 0x526771, capOuter: 0x95a9ae, capInner: 0xc1cfd1,
    floorWall: 0x28363d, floorNear: 0x637b83, floorRadar: 0x3b515b, floorUnknown: 0x293c45,
  },
} satisfies Record<string, StationTheme>;

/** Public appearance only. Never put supplies, hazards or other hidden entities here. */
export const levelArt: Record<string, { theme: keyof typeof stationThemes }> = {
  'station-01': { theme: 'industrial' },
};

export function levelTheme(levelId: string): StationTheme {
  return stationThemes[levelArt[levelId]?.theme ?? 'industrial'];
}
