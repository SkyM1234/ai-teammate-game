import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GameSession } from '../apps/server/src/session.ts';
import { defaultModelConfig, demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ModelAdapter, ToolIntent } from '../apps/server/src/model.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { Level } from '../packages/game-core/src/types.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
const finish: ToolIntent = { name: 'finish_task', arguments: { reason: '本次委托结束。' } };
const report: ToolIntent = { name: 'report', arguments: { text: '已核对当前状态。' } };
const move = (x: number, y: number): ToolIntent => ({ name: 'move_to', arguments: { target: { x, y } } });
function liveSession(rounds: ToolIntent[][], customLevel: Level = level, id?: string) {
  const contexts: string[] = [];
  const adapter: ModelAdapter = { mode: 'live', label: 'local scripted live model', model: demoModel,
    config: { ...defaultModelConfig, mode: 'live' }, ready: true,
    streamFn: (_model, context) => { contexts.push(JSON.stringify(context)); return toolStream(rounds.shift() ?? []); },
  };
  return { session: new GameSession(customLevel, { adapter, delayMs: 0, id }), contexts };
}
function giveMaterial(session: GameSession) {
  const material = session.engine.state.entities.find(entity => entity.id === 's-01')!;
  material.taken = true; session.engine.state.robot.inventory.push(material.id); session.engine.observe();
}
async function authorization(session: GameSession) {
  return new Promise<NonNullable<GameSession['pendingAuthorization']>>((resolve, reject) => {
    const timer = setTimeout(() => { session.listeners.delete(listener); reject(new Error('没有收到授权请求')); }, 1000);
    const listener = () => { if (session.pendingAuthorization) { clearTimeout(timer); session.listeners.delete(listener); resolve(session.pendingAuthorization); } };
    session.listeners.add(listener); listener();
  });
}
function contextTask(context: string) {
  const system = JSON.parse(context).messages.find((message: { role: string }) => message.role === 'system');
  return JSON.parse(system.content.split('当前机器人知识与任务（仅可见事实）：\n')[1]).task;
}

test('真实模式直接接收完整原文与选中位置，不生成关键词目标或要求提交理解', async () => {
  for (const text of ['不要开启电路', '不要维修气闸，先回来', '先修补我的供氧管，然后找电池并回来', '放下之前先报告，不要丢弃物资']) {
    const { session, contexts } = liveSession([[report, finish]]);
    await session.command(text, { x: 4, y: 8 }); await session.settled();
    assert.equal(session.metrics.requests, 1);
    assert.equal(session.engine.state.elapsedTU, 0);
    assert.equal(session.pendingAuthorization, null);
    const task = contextTask(contexts[0]);
    assert.equal(task.text, text); assert.deepEqual(task.selected, { x: 4, y: 8 });
    assert.equal(task.interpretation, 'model'); assert.equal(task.goal, undefined);
    assert.deepEqual(task.constraints.allowedRepairs, []);
    assert.equal(task.constraints.reserveReturnBattery, false);
    assert.equal(session.agent.state.tools.some(tool => tool.name === 'submit_task'), false);
    assert.equal(session.task?.status, 'completed');
    assert.notEqual(session.engine.state.phase, 'success');
  }
});

test('规则演示拒绝否定、条件及复合句，不执行关键词指向的动作', async () => {
  for (const text of ['不要开启电路', '不要维修气闸，先回来', '先修补我的供氧管，然后找电池并回来', '如果电量够就开启电路', '不要放下我']) {
    const session = new GameSession(level, { delayMs: 0 });
    await session.command(text); await session.settled();
    assert.equal(session.task?.demoSupported, false);
    assert.equal(session.task?.goal?.kind, 'custom');
    assert.deepEqual(session.task?.constraints.allowedRepairs, []);
    assert.equal(session.engine.state.elapsedTU, 0);
    assert.equal(session.engine.state.circuitOn, false);
    assert.equal(session.pendingAuthorization, null);
    assert.equal(session.task?.status, 'waiting');
    assert.match(session.task.question!, /简单指令|简单目标/);
  }
});

test('真实模式中的禁止维修文本不会产生自动授权，拒绝模型误调用不扣资源', async () => {
  const { session } = liveSession([[{ name: 'interact', arguments: { operation: 'repair', targetId: 'a-01' } }, report], [finish]]);
  session.engine.state.robot.position = { x: 9, y: 8 }; giveMaterial(session);
  await session.command('不要维修气闸，先回来');
  const request = await authorization(session);
  assert.equal(request.kind, 'repair'); assert.equal(session.engine.state.elapsedTU, 0);
  assert.equal(session.task?.goal, undefined); assert.deepEqual(session.task?.constraints.allowedRepairs, []);
  await session.authorize(request.id, false); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 0);
  assert.equal(session.engine.state.knowledge.entities['a-01'].state, 'damaged');
  assert.equal(session.engine.state.robot.inventory.length, 1);
  assert.ok(!session.messages.some(message => message.text === '已核对当前状态。'));
});

test('真实模式不按开启关键词自动通电，授权在原工具循环内继续', async () => {
  for (const approve of [false, true]) {
    const { session } = liveSession([[{ name: 'set_circuit', arguments: { targetId: 'sw-01', on: true } }, finish], [finish]]);
    session.engine.state.robot.position = { x: 6, y: 2 }; session.engine.observe();
    await session.command(approve ? '开启辅助电路' : '不要开启电路');
    const request = await authorization(session);
    assert.equal(session.engine.state.circuitOn, false); assert.equal(session.engine.state.elapsedTU, 0);
    await session.authorize(request.id, approve); await session.settled();
    assert.equal(session.engine.state.circuitOn, approve);
    assert.equal(session.engine.state.elapsedTU, approve ? 1 : 0);
    assert.equal(session.metrics.requests, approve ? 1 : 2);
  }
});

test('真实模式中的放下关键词不能跳过放下物资授权', async () => {
  const { session } = liveSession([[{ name: 'interact', arguments: { operation: 'drop_item', itemId: 's-01' } }], [finish]]);
  giveMaterial(session);
  await session.command('不要放下维修材料'); const request = await authorization(session);
  assert.equal(request.kind, 'drop');
  await session.authorize(request.id, false); await session.settled();
  assert.deepEqual(session.engine.state.robot.inventory, ['s-01']);
  assert.equal(session.engine.state.elapsedTU, 0);
});

test('真实模式修补后不提前结束复合指令，模型可继续取电池', async () => {
  const customLevel = structuredClone(level);
  const battery = customLevel.entities.find(entity => entity.id === 's-04')!;
  battery.position = { ...customLevel.robotStart }; delete battery.containerId;
  const { session, contexts } = liveSession([
    [{ name: 'interact', arguments: { operation: 'repair', targetId: 'human' } }],
    [{ name: 'interact', arguments: { operation: 'collect', targetId: 's-04' } }, finish],
  ], customLevel);
  giveMaterial(session);
  await session.command('先修补我的供氧管，然后找电池并回来');
  const request = await authorization(session);
  await session.authorize(request.id, true); await session.settled();
  assert.equal(session.engine.state.human.oxygenRate, 1);
  assert.deepEqual(session.engine.state.robot.inventory, ['s-04']);
  assert.equal(session.engine.state.elapsedTU, 7);
  assert.equal(session.metrics.requests, 2);
  assert.equal(session.task?.status, 'completed');
  assert.equal(contextTask(contexts[1]).text, '先修补我的供氧管，然后找电池并回来');
  assert.equal(contextTask(contexts[1]).status, 'active');
});

test('继续真实任务沿用原文和选中位置，不重新产生关键词目标', async () => {
  const { session, contexts } = liveSession([[move(3, 9)], [], [move(4, 9), finish]]);
  await session.command('前往这里，返回时不要放下物资', { x: 4, y: 9 }); await session.settled();
  assert.equal(session.task?.status, 'paused');
  await session.continue(); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, { x: 4, y: 9 });
  for (const context of contexts) {
    const task = contextTask(context);
    assert.equal(task.text, '前往这里，返回时不要放下物资');
    assert.deepEqual(task.selected, { x: 4, y: 9 }); assert.equal(task.goal, undefined);
  }
});

test('旧真实模式存档丢弃关键词目标与自动授权，恢复后暂停', async () => {
  const source = liveSession([[finish]]).session;
  await source.command('不要维修气闸，先回来'); await source.settled();
  const save = source.save(); delete save.modelConfig;
  const legacyTask = save.task! as unknown as Record<string, unknown>;
  delete legacyTask.interpretation;
  legacyTask.goal = { kind: 'repair', targetId: 'airlock' };
  save.task!.constraints.allowedRepairs = ['airlock'];
  save.task!.constraints.authorizedHazardIds = ['h-01'];
  const restored = liveSession([], level, source.id).session;
  await restored.restore(save);
  assert.equal(restored.task?.interpretation, 'model'); assert.equal(restored.task.goal, undefined);
  assert.deepEqual(restored.task.constraints.allowedRepairs, []);
  assert.deepEqual(restored.task.constraints.authorizedHazardIds, []);
  assert.equal(restored.task.status, 'paused'); assert.equal(restored.engine.state.phase, 'paused');
  assert.deepEqual(save.task!.constraints.allowedRepairs, ['airlock']);
});

test('切换到真实模式清除演示目标和授权，切回演示重新校验原文', async () => {
  const session = new GameSession(level, { delayMs: 0 });
  await session.command('修补我的供氧管'); await session.settled();
  assert.deepEqual(session.task?.constraints.allowedRepairs, ['human']);
  await session.configureModel({ ...defaultModelConfig, mode: 'live', provider: 'compatible', modelId: 'local-mock', baseUrl: 'http://127.0.0.1:1/v1' }, 'test-key');
  assert.equal(session.task?.interpretation, 'model'); assert.equal(session.task.goal, undefined);
  assert.deepEqual(session.task.constraints.allowedRepairs, []);
  await session.configureModel(defaultModelConfig, undefined);
  assert.equal(session.task?.interpretation, 'demo');
  assert.equal(session.view().task?.goal?.kind, 'repair'); assert.equal(session.task.demoSupported, true);
});

test('真实模式 finish_task 只能结束委托，不能宣布规则胜利或改写资源', async () => {
  const { session } = liveSession([[{ name: 'finish_task', arguments: { reason: '已经撤离成功。' } }]]);
  await session.command('撤离'); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.equal(session.engine.state.phase, 'awaiting_command');
  assert.equal(session.engine.state.human.oxygen, level.rules.oxygen);
  assert.equal(session.engine.state.robot.battery, level.rules.battery);
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.ledger.length, 0);
});
