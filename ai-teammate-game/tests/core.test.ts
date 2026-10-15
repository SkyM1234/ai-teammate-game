import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diffKnowledge, GameEngine } from '../packages/game-core/src/engine.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { runRescueRoute } from '../scripts/routes.ts';
import type { Action, RadarEcho } from '../packages/game-core/src/types.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));

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

test('机器人可走上实体开关，近距切换更新观察且请求只结算一次', () => {
  const engine = new GameEngine(level);
  engine.state.robot.position = { x: 6, y: 2 }; engine.observe();
  assert.equal(engine.perform({ kind: 'move', target: { x: 6, y: 1 } }).accepted, true);
  const action = { kind: 'circuit' as const, targetId: 'sw-01', on: true };
  const outcome = engine.perform(action, 'switch-on');
  assert.equal(outcome.accepted, true);
  assert.deepEqual(outcome.cost, { tu: 1, battery: 0, oxygen: 2 });
  assert.ok(outcome.delta.stateChanges.some(e => e.id === 'sw-01' && e.state === 'on'));
  assert.deepEqual(engine.perform(action, 'switch-on'), outcome);
  assert.equal(engine.perform(action).accepted, false);
  assert.equal(engine.state.elapsedTU, 2);
  assert.equal(engine.perform({ kind: 'move', target: { x: 6, y: 2 } }).accepted, true);
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
  walk(4, 9); walk(4, 4); walk(6, 4); walk(6, 3);
  original.perform({ kind: 'scan', targetId: 'sw-01' });
  original.perform({ kind: 'circuit', targetId: 'sw-01', on: true });
  original.perform({ kind: 'open', targetId: 'd-01' });
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
  assert.equal(restored.perform({ kind: 'move', target: { x: 6, y: 2 } }).accepted, true);
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
    assert.deepEqual(engine.state.human.position, level.exit);
  }
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
