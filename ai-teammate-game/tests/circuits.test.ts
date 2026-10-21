import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GameEngine, defaultConstraints } from '../packages/game-core/src/engine.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { Level, ObservedEntity } from '../packages/game-core/src/types.ts';
import { GameSession } from '../apps/server/src/session.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';

const template = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
function splitLevel(): Level {
  const level = structuredClone(template);
  level.robotStart = { x: 6, y: 2 };
  level.entities.find(e => e.id === 'sw-01')!.controls = ['c-01', 'h-01'];
  level.entities.push(
    { ...structuredClone(level.entities.find(e => e.id === 'sw-01')!), id: 'sw-02', name: '第二开关', position: { x: 4, y: 1 }, controls: ['d-01', 'h-02'] },
    { id: 'h-02', type: 'hazard', name: '第二线路', position: { x: 5, y: 1 }, reflection: 2, leakCost: 9 },
  );
  return validateLevel(level);
}
function approach(engine: GameEngine, x: number, y: number) {
  engine.state.robot.position = { x, y }; engine.observe();
}
function known(engine: GameEngine, id: string) { return engine.state.knowledge.entities[id]; }

test('发现和操作开关不披露控制列表，检查后才提供名称与ID且不发现远处设备位置', () => {
  const engine = new GameEngine(splitLevel());
  const assertHidden = () => {
    const player = engine.playerView().observed.find(e => e.id === 'sw-01')!;
    const context = engine.robotContext() as { knownEntities: ObservedEntity[] };
    const robot = context.knownEntities.find(e => e.id === 'sw-01')!;
    for (const entity of [player, robot]) {
      assert.equal(entity.controlledDevices, undefined);
      assert.equal(entity.details, undefined);
      assert.ok(!('controls' in entity));
    }
    assert.ok(!JSON.stringify(engine.robotTelemetry()).includes('circuits'));
  };
  assertHidden();
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).accepted, true);
  assertHidden();
  const outcome = engine.perform({ kind: 'scan', targetId: 'sw-01' });
  assert.equal(outcome.accepted, true);
  const devices = known(engine, 'sw-01').controlledDevices!;
  assert.deepEqual(devices.map(e => e.id), ['c-01', 'h-01']);
  assert.ok(devices.every(e => !('position' in e)));
  assert.match(known(engine, 'sw-01').details!, /电池柜.*暴露的带电线路/);
  assert.equal(known(engine, 'h-01'), undefined);
  assert.equal(known(engine, 'sw-02'), undefined);
  assert.deepEqual(engine.playerView().observed.find(e => e.id === 'sw-01')!.controlledDevices, devices);
  assert.deepEqual(outcome.delta.stateChanges.find(e => e.id === 'sw-01')!.controlledDevices, devices);
  const context = engine.robotContext() as { knownEntities: ObservedEntity[] };
  assert.deepEqual(context.knownEntities.find(e => e.id === 'sw-01')!.controlledDevices, devices);
});

test('开关只控制指定门柜与线路，漏电费用和放下玩家按所在电路判断', () => {
  const engine = new GameEngine(splitLevel());
  assert.equal(engine.perform({ kind: 'scan', targetId: 'sw-01' }).accepted, true);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).accepted, true);
  assert.equal(engine.isPowered('c-01'), true);
  assert.equal(engine.isPowered('d-01'), false);
  approach(engine, 6, 3);
  assert.equal(engine.perform({ kind: 'open', targetId: 'd-01' }).code, 'POWER_REQUIRED');
  approach(engine, 5, 2);
  assert.equal(engine.perform({ kind: 'open', targetId: 'c-01' }).accepted, true);
  assert.equal(engine.actionCost({ kind: 'move', target: { x: 8, y: 3 } }).battery, 7);
  assert.equal(engine.actionCost({ kind: 'move', target: { x: 5, y: 1 } }).battery, 1);
  approach(engine, 8, 4);
  assert.equal(known(engine, 'h-01').state, 'active');
  assert.equal(engine.perform({ kind: 'move', target: { x: 8, y: 3 } }).code, 'HAZARD_AUTH_REQUIRED');
  engine.state.human.carried = true; approach(engine, 8, 3);
  assert.equal(engine.perform({ kind: 'drop_human' }).accepted, false);
  approach(engine, 5, 1);
  assert.equal(engine.perform({ kind: 'drop_human' }).accepted, true);
  assert.equal(known(engine, 'h-02').state, 'inactive');
  approach(engine, 4, 2);
  assert.equal(engine.perform({ kind: 'scan', targetId: 'sw-02' }).accepted, true);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-02', on: true }).accepted, true);
  approach(engine, 6, 3);
  assert.equal(engine.perform({ kind: 'open', targetId: 'd-01' }).accepted, true);
  approach(engine, 6, 2);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: false }).accepted, true);
  assert.equal(known(engine, 'h-01').state, 'inactive');
  assert.equal(known(engine, 'h-02').state, 'active');
  assert.equal(engine.isPowered('d-01'), true);
  assert.equal(known(engine, 'c-01').state, 'opened');
  assert.equal(known(engine, 'c-01').powered, false);
  assert.equal(engine.actionCost({ kind: 'move', target: { x: 5, y: 1 } }).battery, 10);
  approach(engine, 8, 4);
  assert.equal(engine.perform({ kind: 'move', target: { x: 8, y: 3 } }).accepted, true);
});

test('寻路只避让各自带电的已知线路，检查后的控制关系可更新远处已知线路', () => {
  const engine = new GameEngine(splitLevel());
  approach(engine, 8, 4);
  approach(engine, 5, 2);
  approach(engine, 6, 2);
  assert.equal(engine.perform({ kind: 'scan', targetId: 'sw-01' }).accepted, true);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).accepted, true);
  assert.equal(known(engine, 'h-01').state, 'active');
  assert.equal(known(engine, 'h-02').state, 'inactive');
  assert.ok(engine.knownPath({ x: 5, y: 1 }));
  assert.equal(engine.knownPath({ x: 8, y: 3 }), null);
  const constraints = defaultConstraints(); constraints.authorizedHazardIds = ['h-01'];
  assert.ok(engine.knownPath({ x: 8, y: 3 }, constraints));
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: false }).accepted, true);
  assert.ok(engine.knownPath({ x: 8, y: 3 }));
});

test('多电路状态与检查知识能保存恢复和按动作回放，旧全局电路存档被拒绝', () => {
  const level = splitLevel();
  const engine = new GameEngine(level);
  assert.equal(engine.perform({ kind: 'scan', targetId: 'sw-01' }).accepted, true);
  assert.equal(engine.perform({ kind: 'circuit', targetId: 'sw-01', on: true }).accepted, true);
  assert.equal(engine.perform({ kind: 'move', target: { x: 5, y: 2 } }).accepted, true);
  assert.equal(engine.perform({ kind: 'open', targetId: 'c-01' }).accepted, true);
  const restored = new GameEngine(level); restored.restore(engine.snapshot());
  assert.deepEqual(restored.state.circuits, { 'sw-01': true, 'sw-02': false });
  assert.deepEqual(restored.robotContext(), engine.robotContext());
  assert.equal(engine.replayAt(0).state.observed.find(e => e.id === 'sw-01')!.controlledDevices, undefined);
  assert.equal(engine.replayAt(1).state.observed.find(e => e.id === 'sw-01')!.state, 'off');
  assert.deepEqual(engine.replayAt(4).state, engine.playerView());
  assert.throws(() => restored.restore({ ...engine.snapshot(), rulesVersion: 4 }), /版本不兼容/);
});

test('开关配置拒绝无效引用、重复归属、非供电对象及缺失控制关系', () => {
  for (const controls of [undefined, ['missing'], ['c-01', 'c-01'], ['sw-01'], ['s-01'], ['d-01'], []]) {
    const level = splitLevel();
    level.entities.find(e => e.id === 'sw-01')!.controls = controls;
    assert.throws(() => validateLevel(level), /开关|控制设备/);
  }
  const level = splitLevel(); level.entities.find(e => e.id === 'c-01')!.controls = [];
  assert.throws(() => validateLevel(level), /仅开关可配置/);
});

test('通电授权在检查前提示影响未知，检查后只列出对应开关的设备', async () => {
  for (const scanned of [false, true]) {
    const session = new GameSession(splitLevel(), { delayMs: 0, adapter: {
      mode: 'live', label: 'circuit test', model: demoModel,
      streamFn: () => toolStream([{ name: 'set_circuit', arguments: { targetId: 'sw-01', on: true } }]),
    } });
    session.engine.state.circuits['sw-02'] = true;
    if (scanned) session.engine.perform({ kind: 'scan', targetId: 'sw-01' });
    const pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未收到通电授权')), 2000);
      const listener = () => { if (session.pendingAuthorization) { clearTimeout(timer); session.listeners.delete(listener); resolve(); } };
      session.listeners.add(listener);
    });
    await session.command('操作附近开关'); await pending;
    const text = session.pendingAuthorization!.consequence;
    if (scanned) { assert.match(text, /电池柜.*暴露的带电线路/); assert.ok(!text.includes('辅助电动门')); }
    else { assert.match(text, /控制设备未知/); assert.ok(!text.includes('电池柜')); assert.ok(!text.includes('h-01')); }
    await session.stop(); await session.settled();
  }
});

test('演示指令按指定开关判断完成，不会因其他开关已通电或断电而提前结束', async () => {
  const session = new GameSession(splitLevel(), { delayMs: 0 });
  approach(session.engine, 4, 2);
  session.engine.state.circuits['sw-01'] = true;
  approach(session.engine, 6, 2);
  await session.command('关闭辅助电路', { x: 6, y: 1 }); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.equal(session.engine.state.circuits['sw-01'], false);
  assert.equal(session.engine.state.circuits['sw-02'], false);
  approach(session.engine, 4, 2);
  await session.command('开启辅助电路', { x: 4, y: 1 }); await session.settled();
  approach(session.engine, 6, 2);
  await session.command('开启辅助电路', { x: 6, y: 1 }); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.deepEqual(session.engine.state.circuits, { 'sw-01': true, 'sw-02': true });
  assert.equal(session.engine.state.knowledge.entities['sw-01'].controlledDevices, undefined);
  assert.deepEqual(session.engine.state.ledger.map(e => e.action), [
    { kind: 'circuit', targetId: 'sw-01', on: false },
    { kind: 'circuit', targetId: 'sw-02', on: true },
    { kind: 'circuit', targetId: 'sw-01', on: true },
  ]);
});
