import { readFile } from 'node:fs/promises';
import { validateLevel } from '../../packages/game-core/src/level.ts';
import type { Level } from '../../packages/game-core/src/types.ts';

const template = validateLevel(JSON.parse(await readFile(new URL('./station-01.json', import.meta.url), 'utf8')));

export function corridorLevel(fourth = false): Level {
  const level = structuredClone(template);
  const rows = fourth ? [1, 5, 7, 9] : [1, 5, 7];
  level.width = 13; level.height = 13;
  level.tiles = Array.from({ length: 13 }, (_, y) => Array.from({ length: 13 }, (_, x) =>
    (x === 1 || x === 11) && y >= 1 && y <= 11 || rows.includes(y) && x >= 1 && x <= 11 ? '.' : '#').join(''));
  level.robotStart = { x: 1, y: 7 }; level.humanStart = { ...level.robotStart };
  level.exit = { x: 11, y: 11, actionCosts: level.exit.actionCosts }; level.rooms = [];
  level.entities = [
    ...[4, 6, 8].map(x => ({ id: `hazard-${x}`, type: 'hazard' as const, name: '线路', position: { x, y: 7 }, reflection: 2 })),
    { id: 'middle-hazard', type: 'hazard', name: '线路', position: { x: 6, y: 5 }, reflection: 2 },
    ...(fourth ? [{ id: 'lower-hazard', type: 'hazard' as const, name: '线路', position: { x: 6, y: 9 }, reflection: 2 }] : []),
  ];
  level.rules.leakCost = 6; level.rules.actionCosts.move = { tu: 1, battery: 1 };
  level.rules.battery = 100; level.rules.oxygen = 100; level.rules.actionTULimit = 100;
  delete level.verification;
  return level;
}
