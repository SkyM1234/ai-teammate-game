import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diffKnowledge, GameEngine } from '../packages/game-core/src/engine.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { runRescueRoute } from '../scripts/routes.ts';
import type { Action, ActionCost, Level, ObservedEntity, RadarEcho } from '../packages/game-core/src/types.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));

test('逐步回溯重建救援资源、物品和知识，任意跳转不改变原局', () => {
  const original = runRescueRoute(level, 'upper');
  const before = original.snapshot();
  const expected = GameEngine.forReplay(level, before.ledger);
  const states = [expected.playerView()];
  for (const entry of before.ledger) {
    assert.equal(expected.replayEntry(entry).accepted, true);
    expected.state.phase = entry.phase;
    states.push(expected.playerView());
  }
  for (const step of [states.length - 1, 0, 1, Math.floor(states.length / 2)]) {
    const replay = original.replayAt(step);
    assert.equal(replay.step, step); assert.equal(replay.total, before.ledger.length);
    assert.deepEqual(replay.state, states[step]);
    replay.state.robot.position.x = -1; replay.entries.length = 0;
    assert.deepEqual(original.snapshot(), before);
  }
  for (const step of [-1, 0.5, NaN, Infinity, states.length]) assert.throws(() => original.replayAt(step), /步数/);
});

test('长对局保留全部回溯节点，资源耗尽的终局也能重建', () => {
  const custom = structuredClone(level); custom.entities = [];
  custom.rules.oxygen = 1000; custom.rules.oxygenMax = 1000; custom.rules.battery = 1000; custom.rules.batteryMax = 1000;
  const engine = new GameEngine(custom);
  for (let index = 0; index < 90; index++) assert.equal(engine.perform({ kind: 'move', target: { x: index % 2 ? 2 : 3, y: 9 } }).accepted, true);
  assert.equal(engine.playerView().ledger.length, 80);
  const replay = engine.replayAt(1);
  assert.equal(replay.entries.length, 90); assert.equal(replay.state.elapsedTU, 1);
  const failure = structuredClone(custom); failure.rules.oxygen = 2;
  const failed = new GameEngine(failure); failed.perform({ kind: 'move', target: { x: 3, y: 9 } });
  assert.equal(failed.replayAt(1).state.phase, 'failure');
  assert.equal(failed.replayAt(1).state.failureReason, '氧气耗尽');
});

test('回溯按行动边界恢复共享和私有标记，保存恢复后仍能查看已移除标记', () => {
  const engine = new GameEngine(level);
  const early = engine.addMarker({ x: 4, y: 7 }, '先前线索', true);
  engine.perform({ kind: 'move', target: { x: 3, y: 9 } });
  const later = engine.addMarker({ x: 3, y: 8 }, '后来的私有线索', false);
  engine.perform({ kind: 'move', target: { x: 3, y: 8 } });
  engine.removeMarker(early.id);
  const restored = new GameEngine(level); restored.restore(engine.snapshot());
  assert.deepEqual(restored.replayAt(0).state.markers, [early]);
  assert.deepEqual(restored.replayAt(1).state.markers, [early, later]);
  assert.deepEqual(restored.replayAt(2).state.markers, [later]);
  assert.deepEqual(restored.state.knowledge.markers, []);
  const legacy = engine.snapshot(); delete legacy.markerHistory;
  restored.restore(legacy);
  assert.deepEqual(restored.replayAt(0).state.markers, []);
});

test('回溯发现账本资源与重建结果不符时明确拒绝', () => {
  const engine = new GameEngine(level);
  engine.perform({ kind: 'move', target: { x: 3, y: 9 } });
  engine.state.ledger[0].oxygen--;
  assert.throws(() => engine.replayAt(1), /行动 1 无法.*重现/);
});

test('重复抱起已在搬运中的玩家返回已满足状态，不误报距离或消耗资源', () => {
  const engine = new GameEngine(level);
  assert.equal(engine.perform({ kind: 'pickup_human' }).code, 'OUT_OF_RANGE');
  engine.state.robot.position = { ...engine.state.human.position };
  assert.equal(engine.perform({ kind: 'pickup_human' }).accepted, true);
  const before = engine.snapshot();
  const result = engine.perform({ kind: 'pickup_human' });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'ALREADY_CARRYING');
  assert.match(result.message, /已.*搬运.*无需再次抱起/);
  assert.deepEqual(result.cost, { tu: 0, battery: 0, oxygen: 0 });
  assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
  assert.equal(engine.state.elapsedTU, before.elapsedTU); assert.deepEqual(engine.state.ledger, before.ledger);
});

test('已耗尽物资在原地或远处均说明已消耗，不能再次扫描、拾取或使用', () => {
  const custom = structuredClone(level);
  custom.entities.find(entity => entity.id === 's-03')!.position = { ...custom.humanStart };
  const engine = new GameEngine(custom);
  engine.state.robot.position = { ...engine.state.human.position }; engine.observe();
  assert.equal(engine.perform({ kind: 'scan', targetId: 's-03' }).accepted, true);
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-03' }).accepted, true);
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-03' }).code, 'ITEM_IN_INVENTORY');
  assert.equal(engine.perform({ kind: 'use_item', itemId: 's-03', targetId: 'human' }).accepted, true);
  assert.equal(engine.state.knowledge.entities['s-03'].state, 'cleared');
  assert.match(engine.state.knowledge.entities['s-03'].details!, /已消耗/);
  assert.ok(!engine.state.knowledge.entities['s-03'].details!.includes('可恢复'));
  const actions: Action[] = [{ kind: 'scan', targetId: 's-03' }, { kind: 'collect', targetId: 's-03' }, { kind: 'use_item', itemId: 's-03', targetId: 'human' }];
  for (const position of [custom.humanStart, { x: 4, y: 9 }]) {
    engine.state.robot.position = { ...position };
    const before = engine.snapshot();
    for (const action of actions) {
      const result = engine.perform(action);
      assert.equal(result.accepted, false); assert.equal(result.code, 'ITEM_CONSUMED');
      assert.match(result.message, /已消耗/); assert.deepEqual(result.cost, { tu: 0, battery: 0, oxygen: 0 });
    }
    assert.equal(engine.state.elapsedTU, before.elapsedTU);
    assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
  }
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-04' }).code, 'UNKNOWN_TARGET');
  const legacy = engine.snapshot();
  legacy.knowledge.entities['s-03'].details = '可恢复 40 氧气。';
  const restored = new GameEngine(custom); restored.restore(legacy);
  const context = restored.robotContext() as { knownEntities: ObservedEntity[] };
  assert.match(context.knownEntities.find(entity => entity.id === 's-03')!.details!, /已消耗/);
  assert.equal(restored.state.knowledge.entities['s-03'].details, '可恢复 40 氧气。');
});

test('维修材料不能当作氧气使用，失败提示指出正确操作', () => {
  const engine = new GameEngine(level);
  engine.state.robot.position = { x: 3, y: 9 }; engine.observe();
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-01' }).accepted, true);
  const before = engine.snapshot();
  const result = engine.perform({ kind: 'use_item', itemId: 's-01', targetId: 'human' });
  assert.equal(result.accepted, false); assert.equal(result.code, 'ITEM_TYPE_MISMATCH');
  assert.match(result.message, /维修材料.*repair/);
  assert.deepEqual(result.cost, { tu: 0, battery: 0, oxygen: 0 });
  assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
});

test('动作消耗配置必须完整且为非负整数，维修材料数量同样校验', () => {
  const groups = (map: Level) => [map.rules.actionCosts, map.human.actionCosts, map.exit.actionCosts, ...map.entities.flatMap(entity => entity.actionCosts ? [entity.actionCosts] : [])] as Record<string, ActionCost & { materials?: number }>[];
  for (const [index, group] of groups(level).entries()) {
    for (const name of Object.keys(group)) {
      const missing = structuredClone(level); Reflect.deleteProperty(groups(missing)[index], name);
      assert.throws(() => validateLevel(missing), /动作消耗/);
      for (const field of ['tu', 'battery'] as const) for (const amount of [undefined, -1, 0.5, Infinity, '2']) {
        const invalid = structuredClone(level); Reflect.set(groups(invalid)[index][name], field, amount);
        assert.throws(() => validateLevel(invalid), /动作消耗/);
      }
      if (name === 'repair') for (const amount of [undefined, -1, 0.5, Infinity, '1']) {
        const invalid = structuredClone(level); Reflect.set(groups(invalid)[index][name], 'materials', amount);
        assert.throws(() => validateLevel(invalid), /维修材料/);
      }
    }
  }
  const missing = structuredClone(level); Reflect.deleteProperty(missing.rules, 'actionCosts');
  assert.throws(() => validateLevel(missing), /动作消耗/);
  const free = structuredClone(level);
  for (const group of groups(free)) for (const cost of Object.values(group)) { cost.tu = 0; cost.battery = 0; if ('materials' in cost) cost.materials = 0; }
  assert.doesNotThrow(() => validateLevel(free));
});

test('所有动作按 JSON 配置扣时间和电量，氧气按当前耗氧率结算', () => {
  const give = (engine: GameEngine, ...ids: string[]) => {
    for (const id of ids) { engine.state.entities.find(e => e.id === id)!.taken = true; engine.state.robot.inventory.push(id); }
  };
  const cases: { name: string; action: Action; setup?: (engine: GameEngine) => void }[] = [
    { name: 'move', action: { kind: 'move', target: { x: 3, y: 9 } } },
    { name: 'carry_move', action: { kind: 'move', target: { x: 3, y: 9 } }, setup: e => { e.state.human.carried = true; } },
    { name: 'scan', action: { kind: 'scan', targetId: 's-01' }, setup: e => { e.state.robot.position = { x: 3, y: 9 }; } },
    { name: 'open', action: { kind: 'open', targetId: 'c-01' }, setup: e => { e.state.robot.position = { x: 5, y: 2 }; e.state.circuitOn = true; } },
    { name: 'collect', action: { kind: 'collect', targetId: 's-01' }, setup: e => { e.state.robot.position = { x: 3, y: 9 }; } },
    { name: 'drop_item', action: { kind: 'drop_item', itemId: 's-01' }, setup: e => give(e, 's-01') },
    { name: 'use_battery', action: { kind: 'use_item', itemId: 's-04', targetId: 'robot' }, setup: e => give(e, 's-04') },
    { name: 'use_oxygen', action: { kind: 'use_item', itemId: 's-03', targetId: 'human' }, setup: e => give(e, 's-03') },
    { name: 'repair_human', action: { kind: 'repair', targetId: 'human' }, setup: e => give(e, 's-01', 's-02') },
    { name: 'repair_airlock', action: { kind: 'repair', targetId: 'a-01' }, setup: e => { give(e, 's-01', 's-02'); e.state.robot.position = { x: 9, y: 8 }; } },
    { name: 'clear', action: { kind: 'clear', targetId: 'o-01' }, setup: e => { e.state.robot.position = { x: 6, y: 10 }; } },
    { name: 'pickup_human', action: { kind: 'pickup_human' }, setup: e => { e.state.robot.position = { ...e.state.human.position }; } },
    { name: 'drop_human', action: { kind: 'drop_human' }, setup: e => { e.state.human.carried = true; } },
    { name: 'circuit', action: { kind: 'circuit', targetId: 'sw-01', on: true }, setup: e => { e.state.robot.position = { x: 6, y: 2 }; } },
    { name: 'extract', action: { kind: 'extract' }, setup: e => { e.state.robot.position = { ...level.exit }; e.state.human.carried = true; e.state.entities.find(e => e.id === 'a-01')!.repaired = true; } },
  ];
  for (const { name, action, setup } of cases) {
    const custom = structuredClone(level);
    for (const group of [custom.rules.actionCosts, custom.human.actionCosts, custom.exit.actionCosts, ...custom.entities.map(entity => entity.actionCosts ?? {})]) {
      for (const cost of Object.values(group)) Object.assign(cost, { tu: 2, battery: 3 });
    }
    custom.human.actionCosts.repair.materials = 2; custom.entities.find(e => e.id === 'a-01')!.actionCosts!.repair!.materials = 2;
    const engine = new GameEngine(validateLevel(custom)); setup?.(engine); engine.observe();
    const outcome = engine.perform(action);
    assert.equal(outcome.accepted, true, `${name}: ${outcome.message}`);
    assert.deepEqual(outcome.cost, { tu: 2, battery: 3, oxygen: 4 }, name);
    assert.equal(engine.state.elapsedTU, 2, name);
    assert.equal(engine.state.robot.battery, name === 'use_battery' ? Math.min(custom.rules.batteryMax, custom.rules.battery - 3 + custom.rules.batteryRefill) : custom.rules.battery - 3, name);
    assert.equal(engine.state.human.oxygen, name === 'use_oxygen' ? 156 : 116, name);
    if (action.kind === 'repair') assert.equal(engine.state.robot.inventory.length, 0, name);
  }
});

test('清障说明、漏电附加消耗和返回电量储备随配置更新', () => {
  const custom = structuredClone(level);
  custom.entities.find(e => e.id === 'o-01')!.actionCosts!.clear! = { tu: 5, battery: 7 };
  custom.rules.actionCosts.move = { tu: 2, battery: 8 };
  custom.rules.actionCosts.carry_move = { tu: 3, battery: 9 };
  custom.rules.leakCost = 11;
  const engine = new GameEngine(custom);
  engine.state.robot.position = { x: 6, y: 10 }; engine.observe();
  assert.equal(engine.perform({ kind: 'scan', targetId: 'o-01' }).accepted, true);
  assert.equal(engine.state.knowledge.entities['o-01'].details, '清理需要 5 TU、7 电量。');
  engine.state.robot.position = { x: 8, y: 4 }; engine.state.circuitOn = true;
  const hazard = engine.perform({ kind: 'move', target: { x: 8, y: 3 } }, crypto.randomUUID(), { reserveReturnBattery: false, reserveMargin: 0, authorizedHazardIds: ['h-01'], stopOnHazard: false, allowedRepairs: [] });
  assert.deepEqual(hazard.cost, { tu: 2, battery: 19, oxygen: 4 });
  engine.state.robot.position = { x: 2, y: 9 }; engine.state.robot.battery = 23;
  assert.equal(engine.perform({ kind: 'move', target: { x: 3, y: 9 } }, crypto.randomUUID(), { reserveReturnBattery: true, reserveMargin: 0, authorizedHazardIds: [], stopOnHazard: false, allowedRepairs: [] }).code, 'RETURN_RESERVE');
  engine.state.human.carried = true;
  assert.deepEqual(engine.actionCost({ kind: 'move', target: { x: 3, y: 9 } }), { tu: 3, battery: 9, oxygen: 6 });
});

test('维修材料不足不扣资源，零材料维修及配置后的存档回放可执行', () => {
  const custom = structuredClone(level);
  custom.human.actionCosts.repair = { tu: 2, battery: 3, materials: 2 };
  const engine = new GameEngine(custom);
  const material = engine.state.entities.find(e => e.id === 's-01')!; material.taken = true;
  engine.state.robot.inventory.push(material.id); engine.observe();
  assert.equal(engine.perform({ kind: 'repair', targetId: 'human' }).code, 'MATERIAL_REQUIRED');
  assert.equal(engine.state.robot.battery, custom.rules.battery); assert.equal(engine.state.human.oxygen, 120); assert.equal(engine.state.elapsedTU, 0);
  custom.human.actionCosts.repair.materials = 0;
  const free = new GameEngine(custom);
  assert.equal(free.perform({ kind: 'repair', targetId: 'human' }).accepted, true);
  assert.equal(free.perform({ kind: 'move', target: { x: 3, y: 9 } }).cost.oxygen, 1);
  const restored = new GameEngine(custom); restored.restore(free.snapshot());
  const replay = GameEngine.forReplay(custom, restored.state.ledger);
  for (const entry of restored.state.ledger) assert.equal(replay.replayEntry(entry).accepted, true);
  assert.deepEqual(replay.state.robot, free.state.robot); assert.deepEqual(replay.state.human, free.state.human);
  assert.equal(replay.state.elapsedTU, free.state.elapsedTU);
});

test('房间范围允许单格与地图边界，拒绝颠倒、越界或缺失的边界', () => {
  for (const bounds of [
    { minX: 1, minY: 9, maxX: 1, maxY: 9 },
    { minX: 0, minY: 0, maxX: level.width - 1, maxY: level.height - 1 },
  ]) {
    const candidate = structuredClone(level); candidate.rooms = [{ name: '测试区', bounds }];
    assert.doesNotThrow(() => validateLevel(candidate));
  }
  for (const bounds of [
    { minX: 4, minY: 1, maxX: 3, maxY: 5 },
    { minX: 1, minY: 5, maxX: 6, maxY: 1 },
    { minX: -1, minY: 1, maxX: 6, maxY: 5 },
    { minX: 1, minY: 1, maxX: level.width, maxY: 5 },
    { minX: 1, minY: 1, maxX: 6, maxY: level.height },
    { minX: 1.5, minY: 1, maxX: 6, maxY: 5 },
    undefined,
  ]) {
    assert.throws(() => validateLevel({ ...level, rooms: [{ name: '测试区', bounds }] }), /房间范围非法/);
  }
});

test('电路开关遵守知识、距离与类型检查，失败不消耗资源', () => {
  const engine = new GameEngine(level);
  assert.ok(!JSON.stringify(engine.playerView()).includes('sw-01'));
  assert.equal(engine.perform({ kind: 'circuit', on: true } as Action).accepted, false);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).code, 'UNKNOWN_TARGET');
  engine.state.robot.position = { x: 6, y: 2 }; engine.observe();
  assert.equal(engine.state.knowledge.entities['sw-01'].state, 'off');
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'c-01', on: true }).accepted, false);
  engine.state.robot.position = { x: 4, y: 4 }; engine.observe();
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).code, 'OUT_OF_RANGE');
  assert.equal(engine.state.elapsedTU, 0);
  assert.equal(engine.state.human.oxygen, level.rules.oxygen);
  assert.equal(engine.state.circuitOn, false);
});

test('气闸控制器和电路开关始终阻挡空载及搬运移动，已知后寻路绕开', () => {
  for (const { id, start, target } of [
    { id: 'a-01', start: { x: 8, y: 9 }, target: { x: 10, y: 9 } },
    { id: 'sw-01', start: { x: 6, y: 2 }, target: { x: 5, y: 1 } },
  ]) for (const active of [false, true]) for (const carried of [false, true]) {
    const engine = new GameEngine(level);
    const entity = engine.state.entities.find(e => e.id === id)!;
    engine.state.robot.position = { ...start }; engine.state.human.carried = carried;
    entity.repaired = active; engine.state.circuitOn = active; engine.observe();
    const before = engine.snapshot();
    const outcome = engine.perform({ kind: 'move', target: entity.position });
    assert.equal(outcome.accepted, false, id);
    assert.equal(outcome.code, 'BLOCKED', id);
    assert.deepEqual(outcome.cost, { tu: 0, battery: 0, oxygen: 0 });
    assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
    assert.equal(engine.state.elapsedTU, 0); assert.equal(engine.state.ledger.length, 0);
    assert.equal(engine.knownPath(entity.position), null);
    const route = engine.knownPath(target);
    assert.ok(route);
    assert.ok(!route.some(p => p.x === entity.position.x && p.y === entity.position.y));
  }
});

test('机器人在相邻格切换开关，更新观察且请求只结算一次', () => {
  const engine = new GameEngine(level);
  engine.state.robot.position = { x: 6, y: 2 }; engine.observe();
  const action = { kind: 'circuit' as const, targetId: 'sw-01', on: true };
  const outcome = engine.perform(action, 'switch-on');
  assert.equal(outcome.accepted, true);
  assert.deepEqual(outcome.cost, { tu: 1, battery: 0, oxygen: 2 });
  assert.ok(outcome.delta.stateChanges.some(e => e.id === 'sw-01' && e.state === 'on'));
  assert.deepEqual(engine.perform(action, 'switch-on'), outcome);
  assert.equal(engine.perform(action).accepted, false);
  assert.equal(engine.state.elapsedTU, 1);
  assert.equal(engine.perform({ kind: 'move', target: { x: 6, y: 3 } }).accepted, true);
  assert.equal(engine.perform({ kind: 'open', targetId: 'd-01' }).accepted, true);
  assert.equal(engine.perform({ kind: 'move', target: { x: 6, y: 2 } }).accepted, true);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: false }).accepted, true);
  assert.equal(engine.state.knowledge.entities['sw-01'].state, 'off');
  assert.equal(engine.state.knowledge.entities['d-01'].state, 'opened');
});

test('旧存档保留资源、账本与电路状态，补入开关；旧远程动作仅可历史回放', () => {
  const original = new GameEngine(level);
  const legacyAction = { kind: 'circuit', on: true } as Action;
  const old = original.snapshot(); old.rulesVersion = 1;
  old.entities = old.entities.filter(e => e.type !== 'switch');
  old.circuitOn = true; old.elapsedTU = 1; old.human.oxygen -= 2; old.stateRevision = 1;
  old.ledger.push({ sequence: 1, actionId: 'legacy-power', action: legacyAction, cost: { tu: 1, battery: 0, oxygen: 2 }, message: '开启辅助电路', position: { ...old.robot.position }, oxygen: old.human.oxygen, battery: old.robot.battery, elapsedTU: 1, phase: old.phase });
  const restored = new GameEngine(level); restored.restore(old);
  assert.equal(restored.state.rulesVersion, 3);
  assert.equal(restored.state.circuitOn, true);
  assert.equal(restored.state.human.oxygen, old.human.oxygen);
  assert.deepEqual(restored.state.ledger, old.ledger);
  assert.ok(restored.state.entities.some(e => e.id === 'sw-01'));
  assert.ok(!restored.state.knowledge.entities['sw-01']);
  const replay = new GameEngine(level);
  assert.equal(replay.replayEntry(old.ledger[0]).accepted, true);
  assert.equal(replay.state.circuitOn, true);
  assert.equal(replay.state.human.oxygen, old.human.oxygen);
  assert.equal(new GameEngine(level).perform(legacyAction).accepted, false);
});

test('旧实体开关存档迁移到新位置，历史与新位置操作混合回放保持一致', () => {
  const oldLevel = structuredClone(level);
  oldLevel.entities.find(e => e.id === 'sw-01')!.position = { x: 6, y: 3 };
  const original = new GameEngine(oldLevel);
  const walk = (x: number, y: number) => {
    while (original.state.robot.position.x !== x) assert.equal(original.perform({ kind: 'move', target: { x: original.state.robot.position.x + Math.sign(x - original.state.robot.position.x), y: original.state.robot.position.y } }).accepted, true);
    while (original.state.robot.position.y !== y) assert.equal(original.perform({ kind: 'move', target: { x, y: original.state.robot.position.y + Math.sign(y - original.state.robot.position.y) } }).accepted, true);
  };
  walk(4, 9); walk(4, 4); walk(6, 4);
  original.perform({ kind: 'scan', targetId: 'sw-01' });
  original.perform({ kind: 'circuit', targetId: 'sw-01', on: true });
  original.perform({ kind: 'circuit', targetId: 'sw-01', on: false });
  const old = original.snapshot(); old.rulesVersion = 2;
  for (const entry of old.ledger) delete entry.targetPosition;
  const restored = new GameEngine(level); restored.restore(old);
  assert.equal(restored.state.rulesVersion, 3);
  assert.deepEqual(restored.state.entities.find(e => e.id === 'sw-01')!.position, { x: 6, y: 1 });
  assert.ok(!restored.state.knowledge.entities['sw-01']);
  assert.ok(!restored.state.knowledge.scannedIds.includes('sw-01'));
  assert.ok(!restored.state.radarHistory.some(e => e.position.x === 6 && e.position.y === 3));
  assert.deepEqual(restored.state.robot, old.robot);
  assert.deepEqual(restored.state.human, old.human);
  for (const target of [{ x: 5, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 3 }, { x: 4, y: 2 }, { x: 5, y: 2 }, { x: 6, y: 2 }]) {
    assert.equal(restored.perform({ kind: 'move', target }).accepted, true);
  }
  assert.equal(restored.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).accepted, true);
  const replay = GameEngine.forReplay(level, restored.state.ledger);
  for (const entry of restored.state.ledger) assert.equal(replay.replayEntry(entry).accepted, true);
  assert.deepEqual(replay.state.robot, restored.state.robot);
  assert.deepEqual(replay.state.human, restored.state.human);
  assert.equal(replay.state.circuitOn, restored.state.circuitOn);
});

test('两条固定救援路线均成功且有资源余量', () => {
  for (const variant of ['upper', 'lower'] as const) {
    const engine = runRescueRoute(level, variant);
    assert.equal(engine.state.phase, 'success');
    assert.ok(engine.state.human.oxygen > 0);
    assert.ok(engine.state.robot.battery > 0);
    assert.deepEqual(engine.state.human.position, { x: level.exit.x, y: level.exit.y });
  }
});

test('出口喷气时空载和搬运均禁止进入，不扣资源；实际维修后解除并可恢复', () => {
  for (const carried of [false, true]) {
    const engine = new GameEngine(level);
    engine.state.robot.position = { x: 10, y: 2 }; engine.state.human.carried = carried;
    const before = engine.snapshot();
    const outcome = engine.perform({ kind: 'move', target: level.exit }, crypto.randomUUID(), { reserveReturnBattery: false, reserveMargin: 0, authorizedHazardIds: ['h-01'], stopOnHazard: false, allowedRepairs: ['airlock'] });
    assert.equal(outcome.code, 'EXIT_LEAK_ACTIVE'); assert.equal(outcome.accepted, false);
    assert.deepEqual(outcome.cost, { tu: 0, battery: 0, oxygen: 0 });
    assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
    assert.equal(engine.state.elapsedTU, 0); assert.equal(engine.state.stateRevision, 0); assert.equal(engine.state.ledger.length, 0);
    assert.equal(engine.knownPath(level.exit), null);
    assert.equal(engine.playerView().exitStatus, 'leaking');
    assert.equal((engine.robotContext() as { exitStatus: string }).exitStatus, 'leaking');
    assert.ok(!JSON.stringify(engine.robotContext()).includes('a-01'));
    engine.state.robot.position = { x: 9, y: 8 };
    const material = engine.state.entities.find(e => e.id === 's-01')!; material.taken = true;
    engine.state.robot.inventory.push(material.id); engine.observe();
    assert.equal(engine.perform({ kind: 'repair', targetId: 'a-01' }).accepted, true);
    assert.equal(engine.exitStatus, 'safe');
    const restored = new GameEngine(level); restored.restore(engine.snapshot());
    assert.equal(restored.playerView().exitStatus, 'safe');
    assert.equal((restored.robotContext() as { exitStatus: string }).exitStatus, 'safe');
    restored.state.robot.position = { x: 10, y: 2 };
    assert.deepEqual(restored.knownPath(level.exit), [{ x: level.exit.x, y: level.exit.y }]);
    assert.equal(restored.perform({ kind: 'move', target: level.exit }).accepted, true);
  }
});

test('寻路不能穿过喷气出口，但仍可到达出口附近；修复后可穿过', () => {
  const corridor = structuredClone(level);
  corridor.width = 5; corridor.height = 4; corridor.tiles = ['#####', '#...#', '#...#', '#####'];
  corridor.exit = { ...corridor.exit, x: 2, y: 1 }; corridor.robotStart = { x: 1, y: 1 }; corridor.humanStart = { x: 1, y: 1 };
  corridor.entities = corridor.entities.filter(e => e.type === 'airlock');
  const engine = new GameEngine(corridor);
  const route = engine.knownPath({ x: 3, y: 1 });
  assert.ok(route); assert.equal(route.length, 4);
  assert.ok(!route.some(p => p.x === corridor.exit.x && p.y === corridor.exit.y));
  engine.state.entities[0].repaired = true;
  assert.equal(engine.knownPath({ x: 3, y: 1 })?.length, 2);
});

test('拒绝非法移动，不扣资源；有效动作重复请求只扣一次', () => {
  const engine = new GameEngine(level);
  assert.equal(engine.perform({ kind: 'move', target: { x: 11, y: 11 } }).accepted, false);
  assert.equal(engine.state.elapsedTU, 0);
  const action = { kind: 'move' as const, target: { x: 3, y: 9 } };
  const first = engine.perform(action, 'same-request');
  assert.deepEqual(engine.perform(action, 'same-request'), first);
  assert.equal(engine.state.elapsedTU, 1);
  assert.equal(engine.state.human.oxygen, 118);
  assert.equal(engine.state.robot.battery, level.rules.battery - 1);
});

test('玩家视图和机器人上下文不包含隐藏对象，雷达不带对象 ID 或类型', () => {
  const engine = new GameEngine(level);
  const player = JSON.stringify(engine.playerView());
  const robot = JSON.stringify(engine.robotContext());
  assert.ok(!player.includes('s-04'));
  assert.ok(!robot.includes('s-04'));
  const context = engine.robotContext() as { radar: RadarEcho[] };
  assert.deepEqual(context.radar, engine.playerView().radar);
  assert.ok(engine.playerView().radar.length > 0);
  for (const echo of context.radar) {
    assert.deepEqual(Object.keys(echo).sort(), ['historical', 'id', 'observedAt', 'position', 'shape', 'strength']);
  }
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-04' }).code, 'UNKNOWN_TARGET');
  assert.equal(engine.state.elapsedTU, 0);
});

test('回波不能用于扫描或拾取，靠近识别后才能扫描实体', () => {
  const engine = new GameEngine(level);
  const context = engine.robotContext() as { radar: RadarEcho[] };
  const echo = context.radar.find(e => e.position.x === 3 && e.position.y === 8)!;
  assert.ok(echo);
  assert.equal(Object.hasOwn(engine.state.knowledge.entities, 's-01'), false);
  for (const targetId of [echo.id, 's-01']) {
    assert.equal(engine.perform({ kind: 'scan', targetId }).code, 'UNKNOWN_TARGET');
    assert.equal(engine.perform({ kind: 'collect', targetId }).code, 'UNKNOWN_TARGET');
  }
  assert.equal(engine.state.elapsedTU, 0);
  assert.equal(engine.state.robot.battery, level.rules.battery);
  assert.equal(engine.state.human.oxygen, level.rules.oxygen);
  const moved = engine.perform({ kind: 'move', target: { x: 3, y: 9 } });
  assert.ok(moved.delta.newDiscoveries.some(e => e.id === 's-01' && e.type === 'supply' && !e.scanned));
  assert.equal(engine.perform({ kind: 'scan', targetId: echo.id }).code, 'UNKNOWN_TARGET');
  assert.equal(engine.perform({ kind: 'scan', targetId: 's-01' }).accepted, true);
  assert.equal(engine.state.knowledge.entities['s-01'].scanned, true);
});

test('机器人与玩家共享更新后的回波和历史时间，快照恢复保留回波', () => {
  const engine = new GameEngine(level);
  const readRadar = () => (engine.robotContext() as { radar: RadarEcho[] }).radar;
  const initial = readRadar().find(e => e.position.x === 3 && e.position.y === 8)!;
  for (const target of [{ x: 3, y: 9 }, { x: 4, y: 9 }, { x: 4, y: 8 }, { x: 4, y: 7 }, { x: 4, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 4 }]) {
    assert.equal(engine.perform({ kind: 'move', target }).accepted, true);
    assert.deepEqual(readRadar(), engine.playerView().radar);
  }
  const lastSeen = readRadar().find(e => e.id === initial.id)!;
  assert.equal(lastSeen.historical, false);
  assert.equal(lastSeen.observedAt, engine.state.elapsedTU);
  assert.equal(engine.perform({ kind: 'move', target: { x: 4, y: 3 } }).accepted, true);
  const historical = readRadar().find(e => e.id === initial.id)!;
  assert.equal(historical.historical, true);
  assert.equal(historical.observedAt, lastSeen.observedAt);
  assert.deepEqual(readRadar(), engine.playerView().radar);
  const restored = new GameEngine(level); restored.restore(engine.snapshot());
  assert.deepEqual(restored.robotContext(), engine.robotContext());
});

test('重复观察归为旧引用，扫描新属性归为状态变化', () => {
  const engine = new GameEngine(level);
  const first = engine.perform({ kind: 'move', target: { x: 3, y: 9 } });
  assert.ok(first.delta.newDiscoveries.some(e => e.id === 's-01'));
  const before = structuredClone(engine.state.knowledge);
  const scanned = engine.perform({ kind: 'scan', targetId: 's-01' });
  assert.equal(scanned.delta.newDiscoveries.length, 0);
  assert.ok(scanned.delta.stateChanges.some(e => e.id === 's-01'));
  assert.ok(diffKnowledge(engine.state.knowledge, engine.state.knowledge).knownRefs.includes('s-01'));
  assert.notDeepEqual(before.entities['s-01'], engine.state.knowledge.entities['s-01']);
});

test('氧气在撤离动作中归零时失败；最后电量用于成功撤离时允许零电量', () => {
  for (const oxygen of [4, 5]) {
    const engine = new GameEngine(level);
    engine.state.robot.position = { ...level.exit };
    engine.state.human.position = { ...level.exit };
    engine.state.human.carried = true;
    engine.state.human.oxygen = oxygen;
    engine.state.robot.battery = 2;
    const airlock = engine.state.entities.find(e => e.type === 'airlock');
    assert.ok(airlock); airlock.repaired = true;
    engine.perform({ kind: 'extract' });
    assert.equal(engine.state.phase, oxygen === 4 ? 'failure' : 'success');
    assert.equal(engine.state.robot.battery, 0);
  }
});

test('物品只能取得一次，修补按旧供氧率消耗后降低泄漏率', () => {
  const engine = new GameEngine(level);
  engine.perform({ kind: 'move', target: { x: 3, y: 9 } });
  engine.perform({ kind: 'collect', targetId: 's-01' });
  const tu = engine.state.elapsedTU;
  assert.equal(engine.perform({ kind: 'collect', targetId: 's-01' }).accepted, false);
  assert.equal(engine.state.elapsedTU, tu);
  engine.perform({ kind: 'move', target: { x: 2, y: 9 } });
  const oxygen = engine.state.human.oxygen;
  engine.perform({ kind: 'repair', targetId: 'human' });
  assert.equal(engine.state.human.oxygen, oxygen - 12);
  assert.equal(engine.state.human.oxygenRate, 1);
  assert.equal(engine.state.robot.inventory.length, 0);
});

test('寻路使用已知地图，未观察障碍不提前绕开', () => {
  const engine = new GameEngine(level);
  engine.state.robot.position = { x: 6, y: 10 };
  const before = engine.knownPath({ x: 8, y: 10 });
  assert.ok(before?.some(p => p.x === 7 && p.y === 10));
  engine.observe();
  const after = engine.knownPath({ x: 8, y: 10 });
  assert.ok(!after?.some(p => p.x === 7 && p.y === 10));
});

test('本地标记不进入机器人上下文，显式共享不消耗时间', () => {
  const engine = new GameEngine(level);
  const local = engine.addMarker({ x: 4, y: 7 }, '本地线索', false);
  assert.ok(!JSON.stringify(engine.robotContext()).includes(local.id));
  const shared = engine.addMarker({ x: 5, y: 7 }, '检查这个回波', true);
  assert.ok(JSON.stringify(engine.robotContext()).includes(shared.id));
  assert.equal(engine.state.elapsedTU, 0);
});

test('按 ID 移除标记同步玩家和机器人知识，保留同格其他标记且不消耗资源', () => {
  const engine = new GameEngine(level);
  const position = { x: 4, y: 7 };
  const local = engine.addMarker(position, '私有线索', false);
  const shared = engine.addMarker(position, '待移除的共享线索', true);
  const retained = engine.addMarker(position, '保留的共享线索', true);
  const before = engine.snapshot();
  assert.equal(engine.removeMarker(shared.id).id, shared.id);
  assert.deepEqual(engine.playerView().markers.map(marker => marker.id), [local.id, retained.id]);
  assert.deepEqual(engine.state.knowledge.markers.map(marker => marker.id), [retained.id]);
  assert.ok(!JSON.stringify(engine.robotContext()).includes(shared.id));
  engine.removeMarker(local.id);
  assert.ok(!JSON.stringify(engine.robotContext()).includes(local.id));
  assert.equal(engine.state.stateRevision, before.stateRevision + 2);
  assert.equal(engine.state.elapsedTU, before.elapsedTU);
  assert.deepEqual(engine.state.human, before.human);
  assert.deepEqual(engine.state.robot, before.robot);
  assert.deepEqual(engine.state.ledger, before.ledger);
  const after = engine.snapshot();
  assert.throws(() => engine.removeMarker(shared.id), /标记不存在/);
  assert.deepEqual(engine.snapshot(), after);
  const restored = new GameEngine(level); restored.restore(after);
  assert.deepEqual(restored.playerView().markers, [retained]);
  assert.deepEqual(restored.state.knowledge.markers, [retained]);
});

test('快照恢复在动作边界暂停，按动作账本回放得到一致的结局', () => {
  const original = runRescueRoute(level, 'upper');
  const restored = new GameEngine(level); restored.restore(original.snapshot());
  assert.equal(restored.state.phase, 'success');
  assert.deepEqual(restored.state.robot, original.state.robot);
  const replay = new GameEngine(level);
  for (const entry of original.state.ledger) {
    const result = replay.perform(entry.action, entry.actionId);
    assert.equal(result.accepted, true);
  }
  assert.equal(replay.state.phase, 'success');
  assert.equal(replay.state.human.oxygen, original.state.human.oxygen);
  assert.equal(replay.state.robot.battery, original.state.robot.battery);
  const active = new GameEngine(level); active.perform({ kind: 'move', target: { x: 3, y: 9 } });
  restored.restore(active.snapshot()); assert.equal(restored.state.phase, 'paused');
});
