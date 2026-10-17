import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GameSession } from '../apps/server/src/session.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ToolIntent } from '../apps/server/src/model.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { ActionCosts } from '../packages/game-core/src/types.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
function scripted(rounds: ToolIntent[][], delayMs = 0, customLevel = level) {
  const contexts: string[] = [];
  const session = new GameSession(customLevel, { delayMs, adapter: {
    mode: 'test', label: 'scripted pi Agent', model: demoModel,
    streamFn: (_model, context) => { contexts.push(JSON.stringify(context)); return toolStream(rounds.shift() ?? []); },
  } });
  return { session, contexts };
}
const move = (x: number, y: number): ToolIntent => ({ name: 'move_to', arguments: { target: { x, y } } });
const report: ToolIntent = { name: 'report', arguments: { text: '状态报告' } };

test('模型明确获知出口喷气规则，move_to 拒绝进入且不扣资源，修复后可进入', async () => {
  const finish: ToolIntent = { name: 'finish_task', arguments: { reason: '本次检查结束。' } };
  const { session, contexts } = scripted([[move(10, 1)], [finish], [move(10, 1), finish]]);
  session.engine.state.robot.position = { x: 10, y: 2 }; session.engine.observe();
  await session.command('前往出口'); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 0);
  assert.deepEqual(session.engine.state.robot.position, { x: 10, y: 2 });
  assert.ok(contexts[0].includes('exitStatus')); assert.ok(contexts[0].includes('leaking'));
  assert.ok(contexts[0].includes('出口这一格禁止进入或穿越')); assert.ok(!contexts[0].includes('a-01'));
  assert.ok(session.messages.some(message => message.tool?.name === 'move_to' && message.tool.status === 'failed' && /漏气/.test(message.text)));
  session.engine.state.entities.find(e => e.type === 'airlock')!.repaired = true;
  await session.command('前往出口'); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, level.exit);
  assert.equal(session.engine.state.elapsedTU, 1);
});

test('规则演示遇到喷气出口明确提示先维修，不重复尝试进入或撤离', async () => {
  for (const command of ['前往 (10,1)', '撤离']) {
    const session = new GameSession(level, { delayMs: 0 });
    await session.command(command); await session.settled();
    assert.equal(session.task?.status, 'waiting'); assert.match(session.task.question!, /漏气.*修复气闸/);
    assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.metrics.requests, 1);
  }
});

test('规则演示按气闸室范围寻找未识别控制器，修复后停止出口漏气', async () => {
  const session = new GameSession(level, { delayMs: 0 });
  session.engine.state.robot.position = { x: 8, y: 8 };
  const material = session.engine.state.entities.find(e => e.id === 's-01')!; material.taken = true;
  session.engine.state.robot.inventory.push(material.id); session.engine.observe();
  assert.equal(session.engine.state.knowledge.entities['a-01'], undefined);
  await session.command('维修气闸控制器'); await session.settled();
  assert.equal(session.task?.status, 'completed'); assert.equal(session.engine.exitStatus, 'safe');
});

test('日志中的氧气交互错误返回参数说明，下一轮可纠正并实际补充氧气', async () => {
  const invalidArguments: ToolIntent['arguments'][] = [
    { operation: 'use_item', targetId: 's-03', itemId: 's-03' },
    { operation: 'use_item', targetId: 's-03' },
  ];
  for (const args of invalidArguments) {
    const { session, contexts } = scripted([
      [{ name: 'interact', arguments: args }],
      [{ name: 'interact', arguments: { operation: 'use_item', itemId: 's-03', targetId: 'human' } }],
      [{ name: 'ask_player', arguments: { question: '已补充氧气，接下来做什么？' } }],
    ]);
    const supply = session.engine.state.entities.find(entity => entity.id === 's-03')!;
    supply.taken = true; session.engine.state.robot.inventory.push(supply.id);
    session.engine.state.human.oxygen = 40; session.engine.observe();
    await session.command('补充氧气给人类'); await session.settled();

    const failure = session.messages.find(message => message.tool?.name === 'interact' && message.tool.status === 'failed');
    assert.match(failure?.text ?? '', /itemId.*targetId.*"human".*"robot"/);
    assert.equal(failure?.at, 0);
    assert.ok(contexts[1].includes('不能把物品 ID 当作 targetId'));
    const ledger = session.engine.state.ledger;
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0].action, { kind: 'use_item', itemId: 's-03', targetId: 'human' });
    assert.equal(session.engine.state.elapsedTU, 2);
    assert.equal(session.engine.state.human.oxygen, 40 - 2 * level.rules.oxygenRate + level.rules.oxygenRefill);
    assert.equal(session.engine.state.robot.battery, level.rules.battery - 2);
    assert.ok(!session.engine.state.robot.inventory.includes('s-03'));
  }
});

async function authorization(session: GameSession) {
  if (session.pendingAuthorization) return session.pendingAuthorization;
  return new Promise<NonNullable<GameSession['pendingAuthorization']>>((resolve, reject) => {
    const timer = setTimeout(() => { session.listeners.delete(listener); reject(new Error('未收到授权请求')); }, 1000);
    const listener = () => { if (session.pendingAuthorization) { clearTimeout(timer); session.listeners.delete(listener); resolve(session.pendingAuthorization); } };
    session.listeners.add(listener); listener();
  });
}

test('一个模型响应中的多个安全工具串行执行，后续结果区分新发现与已有引用', async () => {
  const { session } = scripted([[move(3, 9), move(3, 8), { name: 'ask_player', arguments: { question: '继续吗？' } }]]);
  await session.command('探索附近'); await session.settled();
  assert.equal(session.metrics.requests, 1);
  assert.equal(session.engine.state.elapsedTU, 2);
  const results = session.agent.state.messages.filter(m => m.role === 'toolResult');
  const first = JSON.parse(results[0].content[0].type === 'text' ? results[0].content[0].text : '{}');
  const second = JSON.parse(results[1].content[0].type === 'text' ? results[1].content[0].text : '{}');
  assert.ok(first.newDiscoveries.some((e: {id: string}) => e.id === 's-01'));
  assert.ok(second.knownRefs.includes('s-01'));
  assert.ok(!second.newDiscoveries.some((e: {id: string}) => e.id === 's-01'));
  await assert.rejects(session.continue(), /新指令/);
});

test('移动途中发现相关物资，取消批次余下工具，再请求决策', async () => {
  const { session } = scripted([[move(5, 8), report], [{ name: 'ask_player', arguments: { question: '发现了材料' } }]]);
  await session.command('找维修材料'); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, { x: 2, y: 8 });
  assert.equal(session.engine.state.elapsedTU, 1);
  assert.equal(session.metrics.requests, 2);
  assert.equal(session.metrics.skippedTools, 1);
  assert.ok(!session.messages.some(m => m.text === '状态报告'));
  const calls = session.messages.filter(message => message.kind === 'tool');
  assert.deepEqual(calls.map(message => message.tool?.name), ['move_to', 'report', 'ask_player']);
  assert.deepEqual(calls[0].tool?.arguments, { target: { x: 5, y: 8 } });
  assert.equal(calls[0].tool?.status, 'partial');
  assert.equal(calls[1].tool?.status, 'skipped');
  assert.equal(calls[2].tool?.status, 'waiting');
});

test('设备缺电不会远程通电或要求玩家开关，失败不扣资源并重新决策', async () => {
  const { session, contexts } = scripted([[{ name: 'interact', arguments: { operation: 'open', targetId: 'c-01' } }, report], [report, { name: 'ask_player', arguments: { question: '完成检查' } }]]);
  session.engine.state.robot.position = { x: 4, y: 3 }; session.engine.observe();
  await session.command('检查附近'); await session.settled();
  assert.equal(session.task?.waitReason, 'decision');
  assert.equal(session.engine.state.circuitOn, false);
  assert.equal(session.pendingAuthorization, null);
  assert.equal(session.engine.state.elapsedTU, 0);
  assert.equal(session.metrics.skippedTools, 1);
  await assert.rejects(session.continue());
  assert.equal(session.metrics.requests, 2);
  assert.ok(contexts[1].includes('POWER_REQUIRED'));
  assert.ok(session.messages.some(m => m.text === '状态报告'));
});

test('停止移动只保留已提交格子，等待不扣资源', async () => {
  const { session } = scripted([[move(5, 9), report]], 30);
  await session.command('探索');
  await new Promise<void>(resolve => {
    const listener = () => { if (session.engine.state.elapsedTU > 0) { session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
  await session.stop();
  assert.equal(session.running, false);
  assert.equal(session.engine.state.elapsedTU, 1);
  assert.deepEqual(session.engine.state.robot.position, { x: 3, y: 9 });
  const oxygen = session.engine.state.human.oxygen;
  await session.settled(); assert.equal(session.engine.state.human.oxygen, oxygen);
  assert.ok(!session.messages.some(m => m.text === '状态报告'));
  assert.equal(session.messages.find(message => message.tool?.name === 'move_to')?.tool?.status, 'partial');
  assert.equal(session.messages.find(message => message.tool?.name === 'report')?.tool?.status, 'cancelled');
});

test('共享标记在批次执行中使旧调用失效，模型看到新标记', async () => {
  const { session, contexts } = scripted([[move(5, 9), report], [{ name: 'ask_player', arguments: { question: '收到新标记' } }]], 20);
  await session.command('探索');
  await new Promise<void>(resolve => {
    const listener = () => { if (session.engine.state.elapsedTU > 0) { session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
  session.marker({ x: 4, y: 7 }, '检查新回波', true);
  await session.settled();
  assert.equal(session.engine.state.elapsedTU, 1);
  assert.equal(session.metrics.requests, 2);
  assert.ok(contexts[1].includes('检查新回波'));
  assert.ok(!session.messages.some(m => m.text === '状态报告'));
});

test('移除共享标记中断旧移动批次，后续模型请求与状态工具只包含现存共享标记', async () => {
  const status: ToolIntent = { name: 'get_status', arguments: {} };
  const { session, contexts } = scripted([[status, move(5, 9), report], [status, { name: 'ask_player', arguments: { question: '已更新标记' } }]], 20);
  session.marker({ x: 4, y: 7 }, '已撤销线索', true);
  session.marker({ x: 4, y: 7 }, '保留线索', true);
  session.marker({ x: 4, y: 7 }, '私有线索', false);
  const removed = session.engine.state.markers[0];
  const retained = session.engine.state.markers[1];
  await session.command('探索');
  await new Promise<void>(resolve => {
    const listener = () => { if (session.engine.state.elapsedTU > 0) { session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
  session.removeMarker(removed.id);
  await session.settled();
  assert.equal(session.engine.state.elapsedTU, 1);
  assert.equal(session.metrics.requests, 2);
  assert.ok(!session.messages.some(message => message.text === '状态报告'));
  const knowledge = contexts.map(context => JSON.parse(JSON.parse(context).messages[0].content.split('当前机器人知识与任务（仅可见事实）：\n')[1]));
  assert.deepEqual(knowledge[0].sharedMarkers.map((marker: { id: string }) => marker.id), [removed.id, retained.id]);
  assert.deepEqual(knowledge[1].sharedMarkers.map((marker: { id: string }) => marker.id), [retained.id]);
  assert.ok(contexts[1].includes('sharedMarkers 是当前仍有效的共享标记'));
  assert.ok(contexts.every(context => !context.includes('私有线索')));
  const statuses = session.agent.state.messages.filter(message => message.role === 'toolResult' && message.toolName === 'get_status');
  const latest = statuses.at(-1)!;
  assert.ok(latest.role === 'toolResult' && latest.content[0].type === 'text');
  assert.deepEqual(JSON.parse(latest.content[0].text).sharedMarkers.map((marker: { id: string }) => marker.id), [retained.id]);
});

test('移除私有标记不改变机器人上下文或对话', () => {
  const session = new GameSession(level, { delayMs: 0 });
  session.marker({ x: 4, y: 7 }, '私有线索', false);
  const marker = session.engine.state.markers[0];
  const context = session.engine.robotContext(); const messages = structuredClone(session.messages);
  session.removeMarker(marker.id);
  assert.deepEqual(session.engine.robotContext(), context);
  assert.deepEqual(session.messages, messages);
});

test('新指令取代旧移动，取消的工具不会在新任务中补执行', async () => {
  const { session } = scripted([[move(5, 9), report], [move(2, 9)]], 20);
  await session.command('前往 (5,9)');
  await new Promise<void>(resolve => {
    const listener = () => { if (session.engine.state.elapsedTU > 0) { session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
  await session.command('前往 (2,9)'); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, { x: 2, y: 9 });
  assert.equal(session.engine.state.elapsedTU, 2);
  assert.equal(session.task?.status, 'completed');
  assert.ok(!session.messages.some(m => m.text === '状态报告'));
});

test('无进展循环有限终止，任务上下文不泄露未见的气闸或电池 ID', async () => {
  const { session, contexts } = scripted([[report], [report], [report]]);
  await session.command('维修气闸控制器'); await session.settled();
  assert.equal(session.metrics.requests, 2);
  assert.equal(session.task?.status, 'paused');
  assert.equal(session.engine.state.elapsedTU, 0);
  for (const context of contexts) {
    assert.ok(!context.includes('a-01')); assert.ok(!context.includes('s-04')); assert.ok(context.includes('echo-'));
  }
});

test('模型请求和状态工具包含共享回波，移动后下次请求刷新回波并识别近处对象', async () => {
  const { session, contexts } = scripted([[{ name: 'get_status', arguments: {} }, move(3, 9)], [{ name: 'ask_player', arguments: { question: '已识别附近对象' } }]]);
  const initialRadar = session.engine.playerView().radar;
  await session.command('调查附近回波'); await session.settled();
  assert.equal(contexts.length, 2);
  const knowledge = contexts.map(context => JSON.parse(JSON.parse(context).messages[0].content.split('当前机器人知识与任务（仅可见事实）：\n')[1]));
  assert.deepEqual(knowledge[0].radar, initialRadar);
  assert.deepEqual(knowledge[0].knownEntities, []);
  assert.deepEqual(knowledge[1].radar, session.engine.playerView().radar);
  assert.notDeepEqual(knowledge[1].radar, initialRadar);
  assert.ok(knowledge[1].knownEntities.some((e: { id: string }) => e.id === 's-01'));
  const status = session.agent.state.messages.find(m => m.role === 'toolResult' && m.toolName === 'get_status');
  assert.ok(status?.role === 'toolResult' && status.content[0].type === 'text');
  assert.deepEqual(JSON.parse(status.content[0].text).radar, initialRadar);
  for (const context of contexts) {
    assert.ok(!context.includes('s-04')); assert.ok(!context.includes('c-01'));
  }
});

test('资源耗尽保持失败终态，不进入下一次请求、不误报任务完成', async () => {
  const { session } = scripted([[move(3, 9), report], [report]]);
  session.engine.state.human.oxygen = 2;
  await session.command('前往 (3,9)'); await session.settled();
  assert.equal(session.engine.state.phase, 'failure');
  assert.equal(session.task?.status, 'paused');
  assert.equal(session.metrics.requests, 1);
  assert.ok(!session.messages.some(m => m.text === '状态报告'));
});

test('规则演示能够通过发现、拾取和返回完成供氧管维修', async () => {
  const session = new GameSession(level, { delayMs: 0 });
  await session.command('修补我的供氧管'); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.equal(session.engine.state.human.oxygenRate, 1);
  assert.ok(session.metrics.requests < level.rules.requestLimit);
});

test('规则演示根据房间范围选择落点', async () => {
  for (const name of ['事故舱', '维修区', '设备间']) {
    const session = new GameSession(level, { delayMs: 0 });
    await session.command(`前往${name}`); await session.settled();
    assert.equal(session.task?.status, 'completed');
    const { bounds } = level.rooms.find(room => room.name === name)!;
    const { x, y } = session.engine.state.robot.position;
    assert.ok(x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY);
  }
});

test('每轮行动预算在逐格边界停止，继续后不重复旧动作', async () => {
  const smallBudget = structuredClone(level); smallBudget.rules.actionTULimit = 2;
  const session = new GameSession(smallBudget, { delayMs: 0 });
  await session.command('前往 (5,9)'); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 2);
  assert.deepEqual(session.engine.state.robot.position, { x: 4, y: 9 });
  assert.equal(session.task?.status, 'paused');
  await session.continue(); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 3); assert.equal(session.task?.status, 'completed');
});

test('移动、扫描、交互和开关工具按配置的完整 TU 检查预算', async () => {
  const cases: { cost: keyof ActionCosts; tool: ToolIntent; position: { x: number; y: number }; circuitOn?: boolean }[] = [
    { cost: 'move', tool: move(3, 9), position: { x: 2, y: 9 } },
    { cost: 'scan', tool: { name: 'scan', arguments: { targetId: 's-01' } }, position: { x: 3, y: 9 } },
    { cost: 'clear', tool: { name: 'interact', arguments: { operation: 'clear', targetId: 'o-01' } }, position: { x: 6, y: 10 } },
    { cost: 'circuit', tool: { name: 'set_circuit', arguments: { targetId: 'sw-01', on: false } }, position: { x: 6, y: 2 }, circuitOn: true },
  ];
  for (const { cost, tool, position, circuitOn } of cases) {
    const custom = structuredClone(level); custom.rules.actionCosts[cost].tu = 5; custom.rules.actionTULimit = 4;
    const { session } = scripted([[tool]], 0, custom);
    session.engine.state.robot.position = position; session.engine.state.circuitOn = circuitOn ?? false; session.engine.observe();
    await session.command('检查状态'); await session.settled();
    assert.equal(session.engine.state.elapsedTU, 0, cost);
    assert.equal(session.engine.state.robot.battery, 90, cost);
    assert.equal(session.engine.state.ledger.length, 0, cost);
    assert.ok(session.messages.some(m => m.text.includes('预算不足')), cost);
  }
});

test('修改单步 TU 后预算允许的步数及累计资源一致', async () => {
  const custom = structuredClone(level); custom.rules.actionCosts.move = { tu: 2, battery: 3 }; custom.rules.actionTULimit = 5;
  const session = new GameSession(custom, { delayMs: 0 });
  await session.command('前往 (5,9)'); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, { x: 4, y: 9 });
  assert.equal(session.engine.state.elapsedTU, 4); assert.equal(session.engine.state.robot.battery, 84); assert.equal(session.engine.state.human.oxygen, 112);
  await session.continue(); await session.settled();
  assert.deepEqual(session.engine.state.robot.position, { x: 5, y: 9 }); assert.equal(session.engine.state.elapsedTU, 6);
});

test('单次 move_to 可超过12格，仍在自动运行的 TU 预算边界停止', async () => {
  for (const budget of [30, 13]) {
    const longRoute = structuredClone(level);
    longRoute.robotStart = { x: 1, y: 10 };
    longRoute.entities = [];
    longRoute.exit = { x: 10, y: 10 };
    longRoute.rules.actionTULimit = budget;
    const session = new GameSession(longRoute, { delayMs: 0, adapter: {
      mode: 'test', label: 'long route', model: demoModel,
      streamFn: () => toolStream([move(10, 1)]),
    } });
    await session.command('前往 (10,1)'); await session.settled();
    const steps = Math.min(18, budget);
    assert.equal(session.metrics.requests, 1);
    assert.equal(session.metrics.executedTools, 1);
    assert.equal(session.engine.state.elapsedTU, steps);
    assert.equal(session.engine.state.robot.battery, longRoute.rules.battery - steps);
    assert.equal(session.engine.state.human.oxygen, longRoute.rules.oxygen - steps * longRoute.rules.oxygenRate);
    const result = session.agent.state.messages.find(message => message.role === 'toolResult');
    assert.ok(result?.role === 'toolResult' && result.content[0].type === 'text');
    const outcome = JSON.parse(result.content[0].text);
    assert.equal(outcome.executedSteps, steps);
    assert.equal(outcome.targetReached, budget >= 18);
    assert.equal(session.task?.status, budget >= 18 ? 'completed' : 'paused');
    if (budget >= 18) assert.deepEqual(session.engine.state.robot.position, { x: 10, y: 1 });
  }
});

test('一个响应最多放行六个工具，超额调用跳过且不产生报告', async () => {
  const custom = structuredClone(level); custom.rules.toolLimit = 6;
  const { session } = scripted([[...Array.from({ length: 6 }, () => report), { name: 'report', arguments: { text: '超额报告' } }], [{ name: 'ask_player', arguments: { question: '批次结束' } }]], 0, custom);
  await session.command('探索'); await session.settled();
  assert.equal(session.metrics.skippedTools, 1);
  assert.equal(session.messages.filter(m => m.text === '状态报告').length, 6);
  assert.ok(!session.messages.some(m => m.text === '超额报告'));
});

test('电池柜中的新物资可从相邻格拾取，规则演示不撞进柜体', async () => {
  const session = new GameSession(level, { delayMs: 0 });
  session.engine.state.robot.position = { x: 4, y: 3 }; session.engine.observe();
  await session.command('找电池');
  const pending = await authorization(session); assert.equal(pending.kind, 'power');
  await session.authorize(pending.id, true); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.ok(session.engine.state.robot.inventory.includes('s-04'));
  assert.ok(session.engine.state.ledger.some(e => e.action.kind === 'circuit' && e.action.targetId === 'sw-01'));
  assert.ok(session.engine.state.ledger.every(e => e.action.kind !== 'circuit' || Math.abs(e.position.x - 6) + Math.abs(e.position.y - 1) <= 1));
});

test('同批次操作实体开关前等待按钮授权，拒绝不通电且跳过后续设备操作', async () => {
  const { session, contexts } = scripted([[{ name: 'scan', arguments: { targetId: 'c-01' } }, move(6, 2), { name: 'set_circuit', arguments: { targetId: 'sw-01', on: true } }, { name: 'interact', arguments: { operation: 'open', targetId: 'c-01' } }, report]]);
  session.engine.state.robot.position = { x: 5, y: 2 }; session.engine.observe();
  await session.command('检查附近设备');
  const pending = await authorization(session);
  assert.equal(session.engine.state.elapsedTU, 2);
  assert.equal(session.metrics.executedTools, 2);
  assert.equal(session.metrics.skippedTools, 0);
  assert.equal(session.task?.waitReason, 'authorization');
  assert.equal(session.metrics.requests, 1);
  assert.equal(session.engine.state.knowledge.entities['c-01'].state, 'closed');
  assert.equal(pending.toolName, 'set_circuit');
  assert.equal(pending.arguments.targetId, 'sw-01');
  assert.equal(session.engine.state.circuitOn, false);
  const context = JSON.parse(contexts[0]);
  assert.equal(context.messages.filter((message: { role: string }) => message.role === 'system').length, 1);
  assert.ok(context.messages[0].content.includes('不要编造隐藏物品ID'));
  assert.ok(context.messages[0].content.includes('当前机器人知识'));
  await session.authorize(pending.id, false); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 2); assert.equal(session.metrics.skippedTools, 3);
  assert.equal(session.engine.state.circuitOn, false);
});

test('批准实体开关工具后在原响应继续开柜，无额外模型请求或隐式动作', async () => {
  const { session } = scripted([[{ name: 'set_circuit', arguments: { targetId: 'sw-01', on: true } }, move(5, 2), { name: 'interact', arguments: { operation: 'open', targetId: 'c-01' } }, { name: 'finish_task', arguments: { reason: '检查完成。' } }]]);
  session.engine.state.robot.position = { x: 6, y: 2 }; session.engine.observe();
  await session.command('检查附近设备');
  const pending = await authorization(session);
  assert.equal(session.engine.state.elapsedTU, 0);
  await session.authorize(pending.id, true); await session.settled();
  assert.equal(session.metrics.requests, 1);
  assert.equal(session.engine.state.elapsedTU, 3);
  assert.deepEqual(session.engine.state.ledger.map(e => e.action.kind), ['circuit', 'move', 'open']);
  assert.equal(session.engine.state.circuitOn, true);
});

test('规则演示寻找实体开关，明确开关指令直接授权且断电必须再次靠近', async () => {
  const session = new GameSession(level, { delayMs: 0 });
  session.engine.state.robot.position = { x: 4, y: 3 }; session.engine.observe();
  assert.ok(!JSON.stringify(session.engine.robotContext()).includes('sw-01'));
  await session.command('开启辅助电路'); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.equal(session.engine.state.circuitOn, true);
  assert.equal(session.pendingAuthorization, null);
  await session.manual({ kind: 'move', target: { x: session.engine.state.robot.position.x - 1, y: session.engine.state.robot.position.y } }, 'leave-switch');
  await session.command('关闭辅助电路'); await session.settled();
  assert.equal(session.task?.status, 'completed');
  assert.equal(session.engine.state.circuitOn, false);
  for (const e of session.engine.state.ledger.filter(e => e.action.kind === 'circuit')) assert.ok(Math.abs(e.position.x - 6) + Math.abs(e.position.y - 1) <= 1);
});

function giveMaterial(session: GameSession) {
  const item = session.engine.state.entities.find(e => e.id === 's-01')!;
  item.taken = true; session.engine.state.robot.inventory.push(item.id); session.engine.observe();
}
const repair: ToolIntent = { name: 'interact', arguments: { operation: 'repair', targetId: 'human' } };
const finish: ToolIntent = { name: 'finish_task', arguments: { reason: '检查完成。' } };

test('移除共享标记使待授权动作失效，并使用最新标记重新决策', async () => {
  const { session, contexts } = scripted([[repair, report], [finish]]); giveMaterial(session);
  session.marker({ x: 4, y: 8 }, '待撤销线索', true);
  const marker = session.engine.state.markers[0];
  await session.command('检查救援情况'); const pending = await authorization(session);
  session.removeMarker(marker.id); await session.settled();
  assert.equal(session.pendingAuthorization, null);
  await assert.rejects(session.authorize(pending.id, true), /失效/);
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.human.oxygenRate, 2);
  assert.ok(!session.messages.some(message => message.text === '状态报告'));
  const current = JSON.parse(JSON.parse(contexts[1]).messages[0].content.split('当前机器人知识与任务（仅可见事实）：\n')[1]);
  assert.deepEqual(current.sharedMarkers, []);
});

test('维修工具前暂停，授权后继续同一响应的工具，不新增模型请求', async () => {
  const { session } = scripted([[repair, report, finish]]); giveMaterial(session);
  await session.command('检查救援情况'); const pending = await authorization(session);
  assert.equal(pending.kind, 'repair'); assert.match(pending.consequence, /1 份维修材料/);
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.human.oxygen, 120);
  assert.equal(session.metrics.executedTools, 0); assert.equal(session.metrics.requests, 1);
  assert.equal(session.running, true);
  await session.authorize(pending.id, true); await session.settled();
  assert.equal(session.metrics.requests, 1); assert.equal(session.engine.state.elapsedTU, 6);
  assert.equal(session.engine.state.human.oxygenRate, 1); assert.equal(session.engine.state.robot.inventory.length, 0);
  assert.ok(session.messages.some(m => m.text === '状态报告')); assert.equal(session.pendingAuthorization, null);
  await assert.rejects(session.authorize(pending.id, true), /失效/);
});

test('维修、放下和开关授权提示使用配置消耗，批准后按提示扣除', async t => {
  const cases: { cost: keyof ActionCosts; tool: ToolIntent; setup: (session: GameSession) => void; consequence: RegExp }[] = [
    { cost: 'repair_human', tool: repair, setup: s => { giveMaterial(s); const material = s.engine.state.entities.find(e => e.id === 's-02')!; material.taken = true; s.engine.state.robot.inventory.push(material.id); }, consequence: /2 份维修材料、3 TU、7 电量；预计消耗 6 氧气/ },
    { cost: 'drop_item', tool: { name: 'interact', arguments: { operation: 'drop_item', itemId: 's-01' } }, setup: giveMaterial, consequence: /3 TU、7 电量和 6 氧气/ },
    { cost: 'drop_human', tool: { name: 'interact', arguments: { operation: 'drop_human' } }, setup: s => { s.engine.state.human.carried = true; }, consequence: /3 TU、7 电量和 6 氧气/ },
    { cost: 'circuit', tool: { name: 'set_circuit', arguments: { targetId: 'sw-01', on: true } }, setup: s => { s.engine.state.robot.position = { x: 6, y: 2 }; }, consequence: /3 TU、7 电量和 6 氧气/ },
  ];
  for (const { cost, tool, setup, consequence } of cases) {
    const custom = structuredClone(level); Object.assign(custom.rules.actionCosts[cost], { tu: 3, battery: 7 }); custom.rules.actionCosts.repair_human.materials = 2;
    const { session } = scripted([[tool, finish]], 0, custom); t.after(() => session.stop());
    setup(session); session.engine.observe();
    await session.command('检查救援情况'); const pending = await authorization(session);
    assert.match(pending.consequence, consequence);
    await session.authorize(pending.id, true); await session.settled();
    assert.equal(session.engine.state.elapsedTU, 3, cost); assert.equal(session.engine.state.robot.battery, 83, cost); assert.equal(session.engine.state.human.oxygen, 114, cost);
    if (cost === 'repair_human') assert.equal(session.engine.state.robot.inventory.length, 0);
  }
});

test('拒绝授权不执行当前或后续调用，拒绝结果进入下一模型请求', async () => {
  const { session, contexts } = scripted([[repair, report], [repair, report], [{ name: 'ask_player', arguments: { question: '改用其他路线？' } }]]); giveMaterial(session);
  await session.command('检查救援情况'); const pending = await authorization(session);
  await session.authorize(pending.id, false); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.robot.inventory.length, 1);
  assert.ok(contexts[1].includes('AUTHORIZATION_DENIED')); assert.ok(!session.messages.some(m => m.text === '状态报告'));
  assert.equal(session.pendingAuthorization, null); assert.equal(session.metrics.requests, 2);
});

test('等待授权时停止、手动操作或改令不会死锁，旧授权不能补执行', async () => {
  for (const operation of ['stop', 'manual', 'command']) {
    const { session } = scripted([[repair, report], [finish]]); giveMaterial(session);
    await session.command('检查救援情况'); const pending = await authorization(session);
    if (operation === 'stop') await session.stop();
    else if (operation === 'manual') await session.manual({ kind: 'move', target: { x: 3, y: 9 } }, 'manual');
    else await session.command('重新检查');
    await session.settled();
    assert.equal(session.pendingAuthorization, null);
    await assert.rejects(session.authorize(pending.id, true), /失效/);
    assert.equal(session.engine.state.human.oxygenRate, 2); assert.equal(session.engine.state.elapsedTU, operation === 'manual' ? 1 : 0);
    assert.ok(!session.messages.some(m => m.text === '状态报告'));
  }
});

test('共享信息或状态变化使待授权调用失效，存档恢复不重放挂起调用', async () => {
  const { session } = scripted([[repair, report], [finish]]); giveMaterial(session);
  await session.command('检查救援情况'); const pending = await authorization(session);
  const saved = session.save(); assert.ok(!JSON.stringify(saved).includes(pending.id));
  const restored = new GameSession(level, { id: session.id, delayMs: 0 }); await restored.restore(saved);
  assert.equal(restored.pendingAuthorization, null); assert.equal(restored.task?.status, 'paused'); assert.equal(restored.task?.waitReason, undefined);
  session.marker({ x: 4, y: 8 }, '先检查这里', true); await session.settled();
  await assert.rejects(session.authorize(pending.id, true), /失效/);
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.human.oxygenRate, 2);
});

test('已明确委托的维修无需重复授权，放下物资的授权只用于当前调用', async () => {
  const explicit = scripted([[repair, finish]]).session; giveMaterial(explicit);
  await explicit.command('修补我的供氧管'); await explicit.settled();
  assert.equal(explicit.pendingAuthorization, null); assert.equal(explicit.engine.state.human.oxygenRate, 1);
  const drop = (id: string): ToolIntent => ({ name: 'interact', arguments: { operation: 'drop_item', itemId: id } });
  const { session } = scripted([[drop('s-01'), drop('s-02'), finish]]); giveMaterial(session);
  session.engine.state.entities.find(e => e.id === 's-02')!.taken = true; session.engine.state.robot.inventory.push('s-02'); session.engine.observe();
  await session.command('整理物资'); const first = await authorization(session);
  await session.authorize(first.id, true); const second = await authorization(session);
  assert.notEqual(first.id, second.id); assert.equal(session.engine.state.robot.inventory.length, 1);
  await session.authorize(second.id, false); await session.settled();
  assert.equal(session.engine.state.robot.inventory.length, 1); assert.equal(session.engine.state.elapsedTU, 1);
});

test('危险移动在工具前申请精确线路授权，仅作用于当前调用并保留预算检查', async () => {
  const { session } = scripted([[move(8, 3), report, finish]]);
  session.engine.state.robot.position = { x: 8, y: 4 };
  session.engine.state.circuitOn = true; session.engine.observe();
  await session.command('探索气闸附近'); const pending = await authorization(session);
  assert.equal(pending.kind, 'hazard'); assert.deepEqual(pending.hazardIds, ['h-01']);
  assert.equal(session.engine.state.elapsedTU, 0);
  await session.authorize(pending.id, true); await session.settled();
  assert.equal(session.engine.state.elapsedTU, 1); assert.equal(session.engine.state.robot.battery, 83);
  assert.deepEqual(session.engine.state.robot.position, { x: 8, y: 3 });
  assert.deepEqual(session.task?.constraints.authorizedHazardIds, []);
  assert.deepEqual(session.engine.state.ledger[0].constraints?.authorizedHazardIds, ['h-01']);
  // Entering this cell also reveals a closed door, which correctly invalidates the remaining batch.
  assert.equal(session.metrics.requests, 2); assert.ok(!session.messages.some(m => m.text === '状态报告'));
});

test('等待授权时状态版本改变会拒绝旧决定，已同意操作仍受资源验证', async () => {
  const stale = scripted([[repair], [finish]]).session; giveMaterial(stale);
  await stale.command('检查救援情况'); const pending = await authorization(stale);
  stale.engine.addMarker({ x: 2, y: 8 }, '本地备注', false);
  await assert.rejects(stale.authorize(pending.id, true), /状态已变化/); await stale.settled();
  assert.equal(stale.engine.state.elapsedTU, 0);
  const poor = scripted([[repair], [finish]]).session; giveMaterial(poor);
  poor.engine.state.robot.battery = 3;
  await poor.command('检查救援情况'); const request = await authorization(poor);
  await poor.authorize(request.id, true); await poor.settled();
  assert.equal(poor.engine.state.elapsedTU, 0); assert.equal(poor.engine.state.robot.inventory.length, 1);
  assert.equal(poor.engine.state.human.oxygenRate, 2);
});
