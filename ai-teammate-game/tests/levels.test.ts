import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadLevels } from '../apps/server/src/levels.ts';
import { createAppServer } from '../apps/server/src/server.ts';
import { GameSession } from '../apps/server/src/session.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ToolIntent } from '../apps/server/src/model.ts';
import type { SessionSave, SessionView } from '../apps/server/src/session.ts';
import { parseDemoCommand } from '../apps/server/src/demo-task.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { GameEngine } from '../packages/game-core/src/engine.ts';
import type { Action, Level, ReplayView } from '../packages/game-core/src/types.ts';
import { levelRoutes, verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const source = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
const template = validateLevel(JSON.parse(await readFile(new URL('../docs/maps/template.json', import.meta.url), 'utf8')));
function map(id: string, width: number, height: number): Level {
  return validateLevel({
    ...source, verification: undefined, id, version: 1, name: `测试地图 ${id}`, width, height,
    tiles: Array.from({ length: height }, (_, y) => y === 0 || y === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`),
    humanStart: { x: 1, y: 1 }, robotStart: { x: 2, y: 1 }, exit: { ...source.exit, x: width - 2, y: height - 2 },
    rooms: [{ name: '北侧动力舱', bounds: { minX: 1, minY: 1, maxX: width - 2, maxY: height - 2 } }],
    entities: [
      { id: 'kit-a', type: 'supply', itemType: 'repair', name: '维修包甲', reflection: 1, position: { x: 3, y: 1 }, actionCosts: source.entities.find(e => e.id === 's-01')!.actionCosts },
      { id: 'kit-b', type: 'supply', itemType: 'repair', name: '维修包乙', reflection: 1, position: { x: 2, y: 2 }, actionCosts: source.entities.find(e => e.id === 's-02')!.actionCosts },
      { id: 'control', type: 'airlock', name: '独立控制器', reflection: 2, position: { x: width - 3, y: height - 3 }, actionCosts: source.entities.find(e => e.id === 'a-01')!.actionCosts },
    ],
  });
}
const cleanupByDirectory = new Map<string, (() => Promise<void>)[]>();
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'oxygen-levels-'));
  const cleanup: (() => Promise<void>)[] = []; cleanupByDirectory.set(path, cleanup);
  t.after(async () => { for (const close of cleanup) await close(); await rm(path, { recursive: true, force: true }); cleanupByDirectory.delete(path); }); return path;
}
async function serve(levels: Level[], savesDir: string) {
  const app = createAppServer(levels, { savesDir, delayMs: 0 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  let closed = false;
  async function close() { if (!closed) { closed = true; await app.shutdown(); } }
  cleanupByDirectory.get(savesDir)!.push(close);
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function call<T = SessionView>(path: string, payload?: unknown) {
    const response = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, data: await response.json() as T };
  }
  return { ...app, call, close };
}

test('门朝向配置校验，按已知实体提供显示信息并兼容旧存档', () => {
  for (const orientation of ['horizontal', 'vertical', undefined] as const) {
    const level = map('doors', 8, 6);
    level.entities = [{ id: 'door', type: 'door', name: '门', position: { x: 3, y: 1 }, reflection: 2, orientation, actionCosts: { open: { tu: 1, battery: 1 } } }];
    const engine = new GameEngine(validateLevel(level));
    assert.equal(engine.playerView().observed.find(e => e.id === 'door')?.orientation, orientation);
    const old = engine.snapshot();
    delete old.entities[0].orientation;
    engine.restore(old);
    assert.equal(engine.playerView().observed.find(e => e.id === 'door')?.orientation, orientation);
    engine.state.robot.position = { x: 6, y: 4 };
    engine.state.knowledge.entities = {};
    assert.equal(engine.playerView().observed.length, 0);
    for (const invalid of ['diagonal', 90, null]) {
      const value = structuredClone(level) as any;
      value.entities[0].orientation = invalid;
      assert.throws(() => validateLevel(value), /门朝向非法/);
    }
    level.entities[0].type = 'cabinet'; level.entities[0].orientation = 'horizontal';
    assert.throws(() => validateLevel(level), /门朝向非法/);
  }
});

test('新增 JSON 自动发现，顺序确定，重复 ID 和错误文件给出文件名', async t => {
  const path = await directory(t);
  await assert.rejects(loadLevels(path), /没有地图/);
  await writeFile(join(path, 'z.json'), JSON.stringify(map('tall', 6, 16)));
  await writeFile(join(path, 'a.json'), JSON.stringify(map('wide', 16, 6)));
  assert.deepEqual((await loadLevels(path)).map(level => level.id), ['wide', 'tall']);
  await writeFile(join(path, 'duplicate.json'), JSON.stringify(map('wide', 8, 8)));
  await assert.rejects(loadLevels(path), /duplicate.json.*ID 重复/);
  await rm(join(path, 'duplicate.json'));
  await writeFile(join(path, 'broken.json'), '{}');
  await assert.rejects(loadLevels(path), /broken.json/);
});

test('地图列表只返回公开简介，各局的 HTTP 与 AI 工具按自己的宽高校验', async t => {
  const wide = map('wide', 16, 6); wide.robotStart = { x: 12, y: 1 };
  const tall = map('tall', 6, 16);
  const { call, sessions } = await serve([wide, tall], await directory(t));
  const list = await call<unknown[]>('/api/levels'); assert.equal(list.status, 200);
  assert.equal(list.data.length, 2); assert.ok(!JSON.stringify(list.data).includes('kit-a'));
  assert.equal((await call('/api/sessions', { levelId: '../secret' })).status, 400);
  assert.equal((await call('/api/sessions', { levelId: 42 })).status, 400);
  const a = (await call('/api/sessions', { levelId: 'wide' })).data;
  const b = (await call('/api/sessions', { levelId: 'tall' })).data;
  assert.equal((await call('/api/sessions', {})).data.level.id, 'wide');
  const aPath = `/api/sessions/${a.sessionId}`, bPath = `/api/sessions/${b.sessionId}`;
  const move = await call(`${aPath}/action`, { requestId: crypto.randomUUID(), expectedRevision: 0, action: { kind: 'move', target: { x: 13, y: 1 } } });
  assert.equal(move.status, 200); assert.deepEqual(move.data.robot.position, { x: 13, y: 1 });
  const marker = { requestId: crypto.randomUUID(), expectedRevision: 0, position: { x: 4, y: 14 }, note: '高地图底部', shared: true };
  assert.equal((await call(`${bPath}/marker`, marker)).status, 200);
  assert.equal((await call(`${aPath}/marker`, { ...marker, expectedRevision: move.data.stateRevision, requestId: crypto.randomUUID() })).status, 400);
  assert.equal((await call(`${bPath}/command`, { requestId: crypto.randomUUID(), expectedRevision: 1, text: '过去', selected: { x: 12, y: 2 } })).status, 400);
  const parameters = sessions.get(a.sessionId)!.agent.state.tools.find(tool => tool.name === 'move_to')!.parameters as any;
  assert.equal(parameters.properties.target.properties.x.maximum, 15); assert.equal(parameters.properties.target.properties.y.maximum, 5);
  const tallParameters = sessions.get(b.sessionId)!.agent.state.tools.find(tool => tool.name === 'move_to')!.parameters as any;
  assert.equal(tallParameters.properties.target.properties.x.maximum, 5); assert.equal(tallParameters.properties.target.properties.y.maximum, 15);
});

test('移除地图文件后仍按存档地图恢复和回放，旧存档按 ID 匹配而非默认地图', async t => {
  const savesDir = await directory(t);
  const original = map('saved-map', 16, 6); original.robotStart = { x: 12, y: 1 };
  const first = await serve([original], savesDir);
  const created = (await first.call('/api/sessions', {})).data;
  const path = `/api/sessions/${created.sessionId}`;
  const moved = (await first.call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 0, action: { kind: 'move', target: { x: 13, y: 1 } } })).data;
  await first.close();
  const next = await serve([map('other-map', 6, 16)], savesDir);
  const restored = await next.call(`${path}/load`, {});
  assert.equal(restored.status, 200); assert.equal(restored.data.level.id, original.id); assert.equal(restored.data.level.width, 16);
  assert.deepEqual(restored.data.robot.position, moved.robot.position);
  const replay = await next.call<ReplayView>(`${path}/replay?step=1`);
  assert.equal(replay.status, 200); assert.equal(replay.data.state.level.width, 16); assert.deepEqual(replay.data.state.robot.position, moved.robot.position);
  await next.close();
  const file = join(savesDir, created.sessionId, 'game.json');
  const legacy: SessionSave = JSON.parse(await readFile(file, 'utf8')); delete legacy.level;
  await writeFile(file, JSON.stringify(legacy));
  const compatible = await serve([map('other-map', 6, 16), original], savesDir);
  assert.equal((await compatible.call(`${path}/load`, {})).data.level.id, original.id);
  await compatible.close();
  const incompatible = structuredClone(original); incompatible.version++;
  // Recreate a legacy save to exercise missing historical versions.
  await writeFile(file, JSON.stringify(legacy));
  const mismatch = await serve([incompatible], savesDir);
  assert.equal((await mismatch.call(`${path}/load`, {})).status, 400);
});

test('演示模式使用任意房间名、三位坐标及已知信息搜索，不需要地图专用脚本', async () => {
  const wide = map('wide', 110, 5);
  assert.deepEqual(parseDemoCommand('前往 (103,2)', wide, wide.humanStart).goal.position, { x: 103, y: 2 });
  assert.equal(parseDemoCommand('前往 (110,2)', wide, wide.humanStart).supported, false);
  assert.equal(parseDemoCommand('去北侧动力舱找电池并回来', wide, wide.humanStart).goal.kind, 'collect');
  const level = map('new-room-names', 7, 5);
  const session = new GameSession(level, { delayMs: 0 });
  await session.command('修补我的供氧管'); await session.settled();
  assert.equal(session.task?.status, 'completed'); assert.equal(session.engine.state.human.oxygenRate, level.rules.repairedOxygenRate);
  const knownBefore = JSON.stringify(session.engine.robotContext()); assert.ok(!knownBefore.includes('control'));
  await session.command('维修气闸控制器'); await session.settled();
  assert.equal(session.engine.exitStatus, 'safe');
  assert.ok(!JSON.stringify(session.view()).includes('verification'));
});

test('JSON 内的验证路线使用真实规则完成救援，并拒绝失败或未完成的路线', () => {
  assert.equal(verifyLevelRoute(template)!.state.phase, 'success');
  const level = map('route', 7, 5);
  const actions: Action[] = [
    { kind: 'collect', targetId: 'kit-a' }, { kind: 'repair', targetId: 'human' }, { kind: 'collect', targetId: 'kit-b' },
    { kind: 'move', target: { x: 3, y: 1 } }, { kind: 'move', target: { x: 4, y: 1 } }, { kind: 'repair', targetId: 'control' },
    { kind: 'move', target: { x: 3, y: 1 } }, { kind: 'move', target: { x: 2, y: 1 } }, { kind: 'move', target: { x: 1, y: 1 } }, { kind: 'pickup_human' },
    { kind: 'move', target: { x: 2, y: 1 } },
    { kind: 'move', target: { x: 3, y: 1 } }, { kind: 'move', target: { x: 4, y: 1 } }, { kind: 'move', target: { x: 5, y: 1 } },
    { kind: 'move', target: { x: 5, y: 2 } }, { kind: 'move', target: { x: 5, y: 3 } }, { kind: 'extract' },
  ];
  assert.equal(verifyLevelRoute(level), null);
  level.verification = { actions };
  const result = verifyLevelRoute(level)!; assert.equal(result.state.phase, 'success'); assert.ok(result.state.robot.battery > 0);
  const session = new GameSession(level, { delayMs: 0 }); assert.ok(!JSON.stringify(session.view()).includes('verification'));
  level.verification = { actions: [] }; assert.throws(() => verifyLevelRoute(level), /未完成/);
  level.verification = { actions: [{ kind: 'move', target: { x: 99, y: 1 } }] }; assert.throws(() => verifyLevelRoute(level), /第 1 步/);
});

test('不同地图分别执行 TU 预算，模型收到对应限制和剩余预算', async () => {
  for (const budget of [2, 5]) {
    const level = map(`budget-${budget}`, 16, 6); level.entities = [];
    level.rules.actionTULimit = budget; level.rules.requestLimit = budget;
    const session = new GameSession(level, { delayMs: 0, adapter: {
      mode: 'test', label: '地图预算测试', model: demoModel,
      streamFn: (_model, context) => {
        const system = context.messages.find(message => message.role === 'system');
        assert.ok(system && typeof system.content === 'string');
        const knowledge = JSON.parse(system.content.split('当前机器人知识与任务（仅可见事实）：\n')[1]);
        assert.equal(knowledge.rules.actionTULimit, budget);
        assert.equal(knowledge.rules.requestLimit, budget);
        assert.equal(knowledge.remainingTU, budget);
        assert.equal(knowledge.remainingRequests, budget - 1);
        assert.ok(system.content.includes('rules.toolLimit'));
        return toolStream([{ name: 'move_to', arguments: { target: { x: 10, y: 1 } } }]);
      },
    } });
    await session.command('前往 (10,1)'); await session.settled();
    assert.equal(session.engine.state.elapsedTU, budget);
    assert.deepEqual(session.engine.state.robot.position, { x: 2 + budget, y: 1 });
    assert.equal(session.task, null); assert.equal(session.engine.state.phase, 'awaiting_command');
  }
});

test('地图分别限制模型请求和每轮工具数，耗尽取消委托，新指令重置预算', async () => {
  for (const [requests, tools] of [[1, 2], [3, 8]]) {
    const level = map(`requests-${requests}-tools-${tools}`, 16, 6); level.entities = [];
    level.rules.requestLimit = requests; level.rules.toolLimit = tools; level.rules.actionTULimit = 24;
    const contexts: { rules: Level['rules']; remainingTU: number; remainingRequests: number }[] = [];
    const session = new GameSession(level, { delayMs: 0, adapter: {
      mode: 'test', label: '模型与工具预算测试', model: demoModel,
      streamFn: (_model, context) => {
        const system = context.messages.find(message => message.role === 'system');
        assert.ok(system && typeof system.content === 'string');
        contexts.push(JSON.parse(system.content.split('当前机器人知识与任务（仅可见事实）：\n')[1]));
        const calls: ToolIntent[] = [
          { name: 'move_to', arguments: { target: { x: session.engine.state.robot.position.x + 1, y: 1 } } },
          ...Array.from({ length: tools - 1 }, () => ({ name: 'report', arguments: { text: '预算内报告' } })),
          { name: 'report', arguments: { text: '超出预算报告' } },
        ];
        return toolStream(calls);
      },
    } });
    await session.command('持续向右探索'); await session.settled();
    assert.equal(session.metrics.requests, requests);
    assert.equal(session.metrics.executedTools, requests * tools);
    assert.equal(session.metrics.skippedTools, requests);
    assert.equal(session.task, null); assert.equal(session.engine.state.phase, 'awaiting_command');
    assert.ok(!session.messages.some(message => message.text === '超出预算报告'));
    assert.deepEqual(contexts.map(context => context.remainingRequests), Array.from({ length: requests }, (_, i) => requests - i - 1));
    assert.deepEqual(contexts.map(context => context.remainingTU), Array.from({ length: requests }, (_, i) => 24 - i));
    for (const context of contexts) assert.equal(context.rules.toolLimit, tools);
    await session.command('持续向右探索'); await session.settled();
    assert.equal(session.metrics.requests, requests * 2);
    assert.equal(contexts[requests].remainingRequests, requests - 1);
    assert.equal(contexts[requests].remainingTU, 24);
  }
});

test('所有正式地图的主路线、备用路线按当前配置完成救援并一致回放', async () => {
  const levels = await loadLevels(fileURLToPath(new URL('../content/levels/', import.meta.url)));
  for (const level of levels) {
    assert.ok(level.verification?.actions.length, `${level.id} 缺少主路线`);
    for (const id of Object.keys(levelRoutes(level))) {
      const engine = verifyLevelRoute(level, id)!;
      assert.deepEqual(engine.state.ledger.map(entry => entry.action), levelRoutes(level)[id]);
      const replay = new GameSession(level, { delayMs: 0 });
      for (const entry of engine.state.ledger) assert.equal(replay.engine.replayEntry(entry).accepted, true);
      assert.equal(replay.engine.state.phase, 'success');
      assert.equal(replay.engine.state.elapsedTU, engine.state.elapsedTU);
      assert.deepEqual(replay.engine.state.robot, engine.state.robot);
      assert.deepEqual(replay.engine.state.human, engine.state.human);
    }
    assert.ok(!JSON.stringify(new GameSession(level).engine.robotContext()).includes('verification'));
  }
  const invalid = structuredClone(template);
  invalid.verification!.alternatives = { main: [] };
  assert.throws(() => validateLevel(invalid), /备用验证路线/);
  assert.throws(() => verifyLevelRoute(template, 'missing'), /没有验证路线/);
});

test('规则通关达到地图预算即取消委托，仅新指令可启动后续步骤', async () => {
  const levels = await loadLevels(fileURLToPath(new URL('../content/levels/', import.meta.url)));
  const limitedRequests = structuredClone(template); limitedRequests.rules.requestLimit = 1;
  limitedRequests.rules.actionTULimit = 8;
  for (const level of [...levels, limitedRequests]) {
    const session = new GameSession(level, { delayMs: 0 });
    assert.equal(session.view().demoRescueAvailable, true);
    let runs = 0;
    while (!session.engine.terminal) {
      const before = session.engine.state.elapsedTU;
      await session.command('规则通关'); await session.settled();
      runs++;
      assert.ok(session.engine.state.elapsedTU > before, level.id);
      assert.ok(session.engine.state.elapsedTU - before <= level.rules.actionTULimit);
      assert.equal(session.pendingAuthorization, null);
      if (!session.engine.terminal) {
        assert.equal(session.task, null); assert.equal(session.running, false);
        assert.equal(session.engine.state.phase, 'awaiting_command');
      }
    }
    assert.equal(session.engine.state.phase, 'success', level.id);
    assert.equal(session.task?.status, 'completed');
    assert.equal(session.pendingAuthorization, null);
    assert.equal(session.modelError, null);
    assert.deepEqual(session.engine.state.ledger.map(entry => entry.action), level.verification!.actions);
    if (level === limitedRequests) {
      assert.ok(session.engine.state.elapsedTU > level.rules.actionTULimit);
      assert.ok(runs > 1);
    }
  }
});

test('规则通关停止后取消委托，保存恢复须重新委托，偏离路线时等待玩家', async () => {
  const session = new GameSession(source, { delayMs: 1 });
  let stopping: Promise<void> | undefined;
  session.listeners.add(view => { if (view.elapsedTU >= 10 && !stopping) stopping = session.stop(); });
  await session.command('规则通关'); await session.settled(); await stopping;
  const count = session.engine.state.ledger.length;
  assert.ok(count > 0 && count < source.verification!.actions.length);
  assert.equal(session.engine.state.phase, 'awaiting_command'); assert.equal(session.task, null);
  assert.equal(session.running, false);
  const restored = new GameSession(source, { id: session.id, delayMs: 0 }); await restored.restore(session.save());
  assert.equal(restored.task, null);
  const stopped = restored.engine.snapshot(); const requests = restored.metrics.requests;
  await restored.settled();
  assert.deepEqual(restored.engine.snapshot(), stopped); assert.equal(restored.metrics.requests, requests);
  while (!restored.engine.terminal) { await restored.command('规则通关'); await restored.settled(); }
  assert.equal(restored.engine.state.phase, 'success');
  assert.deepEqual(restored.engine.state.ledger.map(entry => entry.action), source.verification!.actions);
  const deviated = new GameSession(source, { delayMs: 0 });
  await deviated.manual({ kind: 'move', target: { x: 2, y: 10 } }, 'manual');
  const before = deviated.engine.snapshot();
  await deviated.command('规则通关'); await deviated.settled();
  assert.match(deviated.task?.question ?? '', /偏离.*新建/);
  assert.deepEqual(deviated.engine.state.robot, before.robot);
  assert.deepEqual(deviated.engine.state.ledger, before.ledger);
});

test('缺少路线时询问玩家，预算不足时取消规则通关，真实模型不读取预设步骤', async () => {
  const noRoute = map('no-route', 7, 5);
  const missing = new GameSession(noRoute, { delayMs: 0 });
  await missing.command('规则通关'); await missing.settled();
  assert.match(missing.task?.question ?? '', /尚未配置/);
  assert.equal(missing.engine.state.elapsedTU, 0);
  const tooSmall = structuredClone(template); tooSmall.rules.actionTULimit = 1;
  const blocked = new GameSession(tooSmall, { delayMs: 0 });
  await blocked.command('规则通关'); await blocked.settled();
  assert.equal(blocked.engine.state.ledger.length, 1);
  assert.equal(blocked.task, null); assert.equal(blocked.engine.state.phase, 'awaiting_command');
  assert.ok(blocked.metrics.requests <= 3);
  const live = new GameSession(source, { delayMs: 0, adapter: {
    mode: 'live', label: '模拟真实模型', model: demoModel,
    streamFn: (_model, context) => {
      assert.ok(!JSON.stringify(context).includes('verification'));
      return toolStream([{ name: 'ask_player', arguments: { question: '模型自行规划。' } }]);
    },
  } });
  await live.command('规则通关'); await live.settled();
  assert.equal(live.task?.interpretation, 'model');
  assert.equal(live.task?.goal, undefined);
  assert.equal(live.engine.state.ledger.length, 0);
});
