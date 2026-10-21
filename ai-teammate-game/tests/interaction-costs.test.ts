import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GameEngine } from '../packages/game-core/src/engine.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { ObservedEntity } from '../packages/game-core/src/types.ts';
import { verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));

test('地图校验不修改输入，各对象费用独立，重复校验不变', () => {
  const original = structuredClone(level);
  const validated = validateLevel(level);
  assert.deepEqual(level, original);
  assert.deepEqual(Object.keys(validated.rules.actionCosts), ['move', 'carry_move', 'scan']);
  assert.deepEqual(validateLevel(validated), validated);
  const first = validated.entities.find(entity => entity.id === 's-01')!;
  const second = validated.entities.find(entity => entity.id === 's-02')!;
  first.actionCosts!.collect!.tu = 8;
  assert.equal(second.actionCosts!.collect!.tu, 1);
  const control = validated.entities.find(entity => entity.id === 'sw-01')!;
  control.actionCosts!.circuit_on!.tu = 4;
  assert.equal(control.actionCosts!.circuit_off!.tu, 1);
});

test('对象不适用的操作和全局交互费用在加载时拒绝', () => {
  for (const edit of [
    (map: typeof level) => { map.entities.find(e => e.type === 'obstacle')!.actionCosts!.use_item = { tu: 1, battery: 1 }; },
    (map: typeof level) => { map.entities.find(e => e.itemType === 'repair')!.actionCosts!.use_item = { tu: 1, battery: 1 }; },
    (map: typeof level) => { map.entities.find(e => e.type === 'hazard')!.actionCosts = { clear: { tu: 1, battery: 1 } }; },
    (map: typeof level) => { Reflect.set(map.rules.actionCosts, 'clear', { tu: 1, battery: 1 }); },
    (map: typeof level) => { Reflect.set(map.rules.actionCosts.move, 'materials', 1); },
    (map: typeof level) => { Reflect.set(map.rules.actionCosts, 'repair_human', { tu: 1, battery: 1, materials: 1 }); },
  ]) {
    const invalid = structuredClone(level); edit(invalid);
    assert.throws(() => validateLevel(invalid), /动作消耗/);
  }
  for (const entity of level.entities.filter(e => e.actionCosts)) {
    const missing = structuredClone(level); delete missing.entities.find(e => e.id === entity.id)!.actionCosts;
    assert.throws(() => validateLevel(missing), new RegExp(entity.id));
  }
});

test('同类物品拾取、放下和使用独立计费，零费用也实际生效', () => {
  const custom = structuredClone(level);
  const first = custom.entities.find(e => e.id === 's-03')!;
  first.position = { x: 2, y: 8 };
  first.actionCosts = { collect: { tu: 0, battery: 0 }, drop_item: { tu: 2, battery: 3 }, use_item: { tu: 3, battery: 5 } };
  custom.entities.push({ ...structuredClone(first), id: 'second-oxygen', position: { x: 3, y: 9 }, actionCosts: { collect: { tu: 1, battery: 2 }, drop_item: { tu: 0, battery: 0 }, use_item: { tu: 1, battery: 1 } } });
  const engine = new GameEngine(validateLevel(custom));
  assert.deepEqual(engine.perform({ kind: 'collect', targetId: first.id }).cost, { tu: 0, battery: 0, oxygen: 0 });
  assert.deepEqual(engine.perform({ kind: 'collect', targetId: 'second-oxygen' }).cost, { tu: 1, battery: 2, oxygen: 2 });
  assert.deepEqual(engine.perform({ kind: 'drop_item', itemId: first.id }).cost, { tu: 2, battery: 3, oxygen: 4 });
  assert.deepEqual(engine.perform({ kind: 'collect', targetId: first.id }).cost, { tu: 0, battery: 0, oxygen: 0 });
  assert.deepEqual(engine.perform({ kind: 'use_item', itemId: first.id, targetId: 'human' }).cost, { tu: 3, battery: 5, oxygen: 6 });
  assert.deepEqual(engine.perform({ kind: 'use_item', itemId: 'second-oxygen', targetId: 'human' }).cost, { tu: 1, battery: 1, oxygen: 2 });
  assert.equal(engine.state.elapsedTU, 7);
  assert.equal(engine.state.robot.battery, custom.rules.battery - 11);
  assert.deepEqual(engine.state.robot.inventory, []);
});

test('线路漏电消耗必填且仅适用于 hazard，不接受全局配置', () => {
  for (const value of [undefined, null, -1, 1.5, '6']) {
    const invalid = structuredClone(level);
    Reflect.set(invalid.entities.find(e => e.type === 'hazard')!, 'leakCost', value);
    assert.throws(() => validateLevel(invalid), /entities.h-01.leakCost/);
  }
  const invalid = structuredClone(level);
  invalid.entities.find(e => e.type === 'supply')!.leakCost = 6;
  assert.throws(() => validateLevel(invalid), /仅 hazard/);
  const global = structuredClone(level);
  Reflect.set(global.rules, 'leakCost', 6);
  assert.throws(() => validateLevel(global), /必须配置在 hazard 实体/);
});

test('不同线路按自身漏电消耗结算和展示，零消耗与断电均生效', () => {
  const custom = structuredClone(level);
  custom.entities = [
    { id: 'free-wire', type: 'hazard', name: '线路', position: { x: 3, y: 9 }, reflection: 2, leakCost: 0 },
    { id: 'costly-wire', type: 'hazard', name: '线路', position: { x: 4, y: 9 }, reflection: 2, leakCost: 11 },
  ];
  const engine = new GameEngine(validateLevel(custom));
  assert.equal(engine.state.knowledge.entities['free-wire'].leakCost, 0);
  assert.ok(!engine.state.knowledge.entities['costly-wire']);
  engine.state.circuitOn = true;
  const constraints = { reserveReturnBattery: false, reserveMargin: 0, authorizedHazardIds: ['free-wire', 'costly-wire'], stopOnHazard: false, allowedRepairs: [] };
  for (const [id, battery] of [['free-wire', 1], ['costly-wire', 12]] as const) {
    assert.equal(engine.perform({ kind: 'scan', targetId: id }).accepted, true);
    const observed = engine.state.knowledge.entities[id];
    assert.equal(observed.leakCost, battery - 1);
    assert.match(observed.details!, new RegExp(`额外消耗 ${battery - 1} 电量`));
    assert.deepEqual(engine.perform({ kind: 'move', target: observed.position }, crypto.randomUUID(), constraints).cost, { tu: 1, battery, oxygen: 2 });
  }
  engine.state.circuitOn = false;
  engine.state.robot.position = { x: 3, y: 9 };
  assert.deepEqual(engine.perform({ kind: 'move', target: { x: 4, y: 9 } }).cost, { tu: 1, battery: 1, oxygen: 2 });
});

test('不同障碍的清理说明与扣费一致，开启和关闭电路分别结算', () => {
  const custom = structuredClone(level);
  const first = custom.entities.find(e => e.id === 'o-01')!;
  first.position = { x: 2, y: 8 }; first.actionCosts!.clear = { tu: 2, battery: 3 };
  custom.entities.push({ ...structuredClone(first), id: 'large-obstacle', position: { x: 3, y: 9 }, actionCosts: { clear: { tu: 4, battery: 7 } } });
  const control = custom.entities.find(e => e.id === 'sw-01')!;
  control.position = { x: 2, y: 10 };
  control.actionCosts = { circuit_on: { tu: 2, battery: 4 }, circuit_off: { tu: 0, battery: 0 } };
  const engine = new GameEngine(validateLevel(custom));
  for (const [id, tu, battery] of [['o-01', 2, 3], ['large-obstacle', 4, 7]] as const) {
    assert.equal(engine.perform({ kind: 'scan', targetId: id }).accepted, true);
    assert.equal(engine.state.knowledge.entities[id].details, `清理需要 ${tu} TU、${battery} 电量。`);
    assert.deepEqual(engine.perform({ kind: 'clear', targetId: id }).cost, { tu, battery, oxygen: tu * 2 });
  }
  assert.deepEqual(engine.perform({ kind: 'circuit', targetId: control.id, on: true }).cost, { tu: 2, battery: 4, oxygen: 4 });
  assert.deepEqual(engine.perform({ kind: 'circuit', targetId: control.id, on: false }).cost, { tu: 0, battery: 0, oxygen: 0 });
});

test('维修需求归目标所有，不同控制器分别检查材料，不足时不扣费', () => {
  const custom = structuredClone(level);
  custom.human.actionCosts.repair.materials = 0;
  const first = custom.entities.find(e => e.id === 'a-01')!;
  first.position = { x: 2, y: 8 }; first.actionCosts!.repair = { tu: 2, battery: 3, materials: 2 };
  custom.entities.push({ ...structuredClone(first), id: 'second-airlock', position: { x: 3, y: 9 }, actionCosts: { repair: { tu: 3, battery: 5, materials: 1 } } });
  const engine = new GameEngine(validateLevel(custom));
  const material = engine.state.entities.find(e => e.id === 's-01')!;
  material.taken = true; engine.state.robot.inventory.push(material.id); engine.observe();
  const before = engine.snapshot();
  assert.equal(engine.perform({ kind: 'repair', targetId: first.id }).code, 'MATERIAL_REQUIRED');
  assert.equal(engine.state.elapsedTU, before.elapsedTU); assert.deepEqual(engine.state.robot, before.robot);
  assert.equal(engine.perform({ kind: 'scan', targetId: first.id }).accepted, true);
  assert.match(engine.state.knowledge.entities[first.id].details!, /需要 2 份维修材料/);
  assert.deepEqual(engine.perform({ kind: 'repair', targetId: 'second-airlock' }).cost, { tu: 3, battery: 5, oxygen: 6 });
  assert.deepEqual(engine.state.robot.inventory, []);
  assert.equal(engine.state.entities.find(e => e.id === 'second-airlock')!.repaired, true);
  assert.equal(engine.state.entities.find(e => e.id === first.id)!.repaired, false);
});

test('保存恢复后 AI 仅获取已知物体费用，回放保留原消耗', () => {
  const engine = verifyLevelRoute(level)!;
  const old = engine.snapshot();
  const restored = new GameEngine(level); restored.restore(old);
  assert.deepEqual(restored.playerView().human.actionCosts, level.human.actionCosts);
  const context = restored.robotContext() as { knownEntities: ObservedEntity[] };
  assert.deepEqual(context.knownEntities.find(e => e.id === 's-01')!.actionCosts, level.entities.find(e => e.id === 's-01')!.actionCosts);
  const replay = restored.replayAt(old.ledger.length).state;
  assert.equal(replay.elapsedTU, old.elapsedTU); assert.equal(replay.robot.battery, old.robot.battery); assert.equal(replay.human.oxygen, old.human.oxygen);
  const initial = new GameEngine(level).robotContext() as { knownEntities: ObservedEntity[] };
  assert.ok(!initial.knownEntities.some(e => e.id === 's-04'));
});
