import assert from 'node:assert/strict';
import test from 'node:test';
import { corridorLevel } from './fixtures/corridors.ts';
import { findKnownRoutes } from '../packages/game-core/src/route-planner.ts';
import { distance, positionKey, samePosition } from '../packages/game-core/src/types.ts';
import type { Knowledge, Level, Position } from '../packages/game-core/src/types.ts';


function knowledgeFor(level: Level): Knowledge {
  return { entities: Object.fromEntries(level.entities.map(entity => [entity.id, { ...entity, state: entity.type === 'door' ? 'closed' : 'active', scanned: false, observedAt: 0, source: 'sensor' as const }])), scannedIds: [], markers: [] };
}

const target = { x: 11, y: 7 };
function routes(level: Level, knowledge = knowledgeFor(level), carried = false, circuitOn = true) {
  return findKnownRoutes(level, knowledge, level.robotStart, target, circuitOn, carried, false);
}
function assertValid(level: Level, paths: Position[][]) {
  assert.equal(new Set(paths.map(path => path.map(positionKey).join(';'))).size, paths.length);
  for (const path of paths) {
    assert.ok(samePosition(path.at(-1)!, target));
    const full = [level.robotStart, ...path];
    assert.equal(new Set(full.map(positionKey)).size, full.length);
    for (let index = 1; index < full.length; index++) {
      assert.equal(distance(full[index - 1], full[index]), 1);
      assert.notEqual(level.tiles[full[index].y][full[index].x], '#');
    }
  }
}

test('最少带电、最低电量、最少步数可以是三条不同路线', () => {
  const level = corridorLevel();
  const paths = routes(level);
  assert.deepEqual(paths.map(path => path.length), [22, 14, 10]);
  const costs = paths.map(path => path.length + path.reduce((total, p) => total + (level.entities.find(e => samePosition(e.position, p))?.leakCost ?? 0), 0));
  assert.deepEqual(costs, [22, 20, 28]);
  assertValid(level, paths);
});

test('同消耗的不同走廊仍可作为第四条路线，循环和重复路径不会进入候选', () => {
  const level = corridorLevel(true);
  const paths = routes(level);
  assert.equal(paths.length, 4);
  assert.ok(paths.some(path => path.some(p => p.x === 6 && p.y === 9)));
  assertValid(level, paths);
  assert.deepEqual(routes(level), paths);
});

test('最低电量路线读取每条已知线路的费用，包括零费用', () => {
  const level = corridorLevel();
  level.entities.find(e => e.id === 'middle-hazard')!.leakCost = 30;
  for (const entity of level.entities.filter(e => e.position.y === 7)) entity.leakCost = 0;
  const paths = routes(level);
  assert.deepEqual(paths.map(path => path.length), [22, 10, 14]);
  assertValid(level, paths);
});

test('最低电量路径根据搬运消耗变化，零电量消耗也不会产生循环', () => {
  const level = corridorLevel(); level.rules.actionCosts.carry_move = { tu: 2, battery: 10 };
  assert.deepEqual(routes(level, knowledgeFor(level), true).map(path => path.length), [22, 10, 14]);
  level.rules.actionCosts.move.battery = 0;
  assertValid(level, routes(level));
});

test('规划只使用已知实体，断电后不再按带电格避让', () => {
  const level = corridorLevel();
  const unknown: Knowledge = { entities: {}, scannedIds: [], markers: [] };
  assert.equal(routes(level, unknown)[0].length, 10);
  assert.equal(routes(level, knowledgeFor(level), false, false)[0].length, 10);
});

test('墙、已知阻挡和漏气出口排除，当前位置返回空路径，无路返回空列表', () => {
  const level = corridorLevel();
  const knowledge = knowledgeFor(level);
  assert.deepEqual(findKnownRoutes(level, knowledge, level.robotStart, level.robotStart, true, false, false), [[]]);
  assert.deepEqual(findKnownRoutes(level, knowledge, level.robotStart, { x: 0, y: 0 }, true, false, false), []);
  assert.deepEqual(findKnownRoutes(level, knowledge, level.robotStart, level.exit, true, false, true), []);
  for (const type of ['door', 'obstacle', 'cabinet', 'switch', 'airlock'] as const) {
    knowledge.entities.blocker = { id: 'blocker', type, name: '阻挡', position: target, state: 'closed', scanned: false, observedAt: 0, source: 'sensor' };
    assert.deepEqual(routes(level, knowledge), []);
  }
  delete knowledge.entities.blocker;
  level.tiles[7] = '#.#########.#';
  assert.ok(routes(level, knowledge).every(path => path.length > 10));
  level.tiles[6] = '#############'; level.tiles[8] = '#############';
  assert.deepEqual(routes(level, knowledge), []);
});
