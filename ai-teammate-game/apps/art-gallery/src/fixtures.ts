import type { ObservedEntity, PlayerView } from '../../../packages/game-core/src/types.ts';

/** Synthetic, public observations for art review. No authoritative level entities. */
export function galleryView(layout: 'square' | 'long' | 'walls', alternateState: boolean): PlayerView {
  if (layout === 'walls') return wallGalleryView(alternateState);
  const width = layout === 'square' ? 12 : 9, height = layout === 'square' ? 12 : 14;
  const definitions: Omit<ObservedEntity, 'observedAt' | 'source' | 'scanned'>[] = [
    { id: 'oxygen', type: 'supply', name: '氧气', position: { x: 2, y: 3 }, itemType: 'oxygen', state: 'available' },
    { id: 'battery', type: 'supply', name: '电池', position: { x: 4, y: 3 }, itemType: 'battery', state: 'available' },
    { id: 'repair', type: 'supply', name: '维修箱', position: { x: 6, y: 3 }, itemType: 'repair', state: 'available' },
    { id: 'door', type: 'door', name: '门', position: { x: 2, y: 6 }, state: alternateState ? 'opened' : 'closed' },
    { id: 'cabinet', type: 'cabinet', name: '柜', position: { x: 4, y: 6 }, state: alternateState ? 'opened' : 'closed' },
    { id: 'airlock', type: 'airlock', name: '控制器', position: { x: 6, y: 6 }, state: alternateState ? 'repaired' : 'damaged' },
    { id: 'switch', type: 'switch', name: '开关', position: { x: 2, y: 9 }, state: alternateState ? 'on' : 'off' },
    { id: 'hazard', type: 'hazard', leakCost: 6, name: '线缆', position: { x: 4, y: 9 }, state: alternateState ? 'inactive' : 'active' },
    { id: 'obstacle', type: 'obstacle', name: '障碍', position: { x: 6, y: 9 }, state: 'blocked' },
  ];
  const observed: ObservedEntity[] = definitions.map(entity => ({ ...entity, observedAt: 0, source: 'sensor', scanned: true }));
  const tiles = Array.from({ length: height }, (_, y) => y === 0 || y === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  const sensorCells = tiles.flatMap((row, y) => [...row].flatMap((tile, x) => tile === '#' ? [] : [{ x, y }]));
  return {
    level: { id: `art-gallery-${layout}`, name: '美术资源展示', width, height, tiles, rooms: [], exit: { x: width - 2, y: height - 2, actionCosts: { extract: { tu: 1, battery: 1 } } } },
    exitStatus: alternateState ? 'safe' : 'leaking', phase: 'paused', stateRevision: 0, elapsedTU: 0, circuitOn: alternateState,
    robot: { position: { x: 2, y: 1 }, battery: 90, inventory: [] },
    human: { position: { x: alternateState ? 2 : 4, y: 1 }, oxygen: 120, oxygenRate: 2, carried: alternateState, actionCosts: { repair: { tu: 1, battery: 1, materials: 1 }, pickup_human: { tu: 1, battery: 1 }, drop_human: { tu: 1, battery: 1 } } },
    rules: {
      oxygen: 120, oxygenMax: 180, oxygenRate: 2, repairedOxygenRate: 1,
      battery: 90, batteryMax: 100, batteryRefill: 30, oxygenRefill: 40,
      inventorySlots: 2, sensorRadius: 1, radarRadius: 5,
      moveLimit: 12, toolLimit: 6, requestLimit: 8, actionTULimit: 12,
      actionCosts: {
        move: { tu: 1, battery: 1 }, carry_move: { tu: 1, battery: 2 }, scan: { tu: 1, battery: 1 },
      },
    },
    observed, radar: [], markers: [], sensorCells, ledger: [], failureReason: null,
  };
}

function wallGalleryView(alternateState: boolean): PlayerView {
  const view = galleryView('square', alternateState);
  view.level.id = 'art-gallery-walls'; view.level.name = '墙面组合展示';
  view.level.tiles = view.level.tiles.map((row, y) => {
    if (y === 0 || y === 11) return row;
    if (y === 6) return '###.####.###';
    return y === 3 || y === 9 ? row : `${row.slice(0, 6)}#${row.slice(7)}`;
  });
  const positions = {
    oxygen: { x: 3, y: 9 }, battery: { x: 8, y: 3 }, repair: { x: 3, y: 3 },
    door: { x: 6, y: 3 }, cabinet: { x: 9, y: 2 }, airlock: { x: 9, y: 8 },
    switch: { x: 8, y: 2 }, hazard: { x: 8, y: 4 }, obstacle: { x: 4, y: 8 },
  };
  for (const entity of view.observed) entity.position = positions[entity.id as keyof typeof positions];
  view.robot.position = { x: 2, y: 8 }; view.human.position = { x: 2, y: alternateState ? 8 : 9 };
  view.sensorCells = view.level.tiles.flatMap((row, y) => [...row].flatMap((tile, x) => tile === '#' ? [] : [{ x, y }]));
  return view;
}
