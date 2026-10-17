import type { PlayerView, Position } from '../../../../packages/game-core/src/types.ts';

export const wallHeights = { outer: 1.2, inner: 1.4 };

/** Terrain and doors share the same boundary rule and height settings. */
export function wallHeightAt(level: Pick<PlayerView['level'], 'width' | 'height'>, cell: Position) {
  const boundary = cell.x === 0 || cell.y === 0 || cell.x === level.width - 1 || cell.y === level.height - 1;
  return boundary ? wallHeights.outer : wallHeights.inner;
}
