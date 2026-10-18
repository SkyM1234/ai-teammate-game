import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameSession } from '../apps/server/src/session.ts';
import { defaultModelConfig, demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ModelAdapter, ToolIntent } from '../apps/server/src/model.ts';
import { SessionJournal } from '../apps/server/src/journal.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { getCurrentTools } from '../../pi-main/packages/ai/dist/utils/transcript.js';
import type { TranscriptContext } from '../../pi-main/packages/ai/dist/types.js';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
const finish: ToolIntent = { name: 'finish_task', arguments: { reason: '实际结果确认委托已经完成。' } };
const report: ToolIntent = { name: 'report', arguments: { text: '本次行动已经停止。' } };
const move = (x: number, y = 9): ToolIntent => ({ name: 'move_to', arguments: { target: { x, y } } });
const snapshot = (context: TranscriptContext) => JSON.parse((context.messages[0].content as string).split('当前机器人知识与任务（仅可见事实）：\n')[1]);
function scripted(rounds: ToolIntent[][], custom = level) {
  const contexts: TranscriptContext[] = [];
  const adapter: ModelAdapter = { mode: 'live', label: 'budget closing mock', model: demoModel,
    streamFn: (_model, context) => { contexts.push(structuredClone(context)); return toolStream(rounds.shift() ?? []); },
  };
  return { session: new GameSession(custom, { adapter, delayMs: 0 }), contexts };
}
async function waitFor(session: GameSession, condition: () => boolean) {
  if (condition()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { session.listeners.delete(listener); reject(new Error('未收到预期状态')); }, 1000);
    const listener = () => { if (condition()) { clearTimeout(timer); session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
}

test('维修恰好耗尽 TU 和请求预算后，沿原对话只用报告与完成工具收尾并保留日志', async t => {
  const custom = structuredClone(level);
  custom.rules.actionTULimit = custom.rules.actionCosts.repair_human.tu; custom.rules.requestLimit = 1;
  const { session, contexts } = scripted([
    [{ name: 'interact', arguments: { operation: 'repair', targetId: 'human' } }, move(3), finish],
    [report, finish],
  ], custom);
  session.engine.state.robot.position = { ...custom.humanStart };
  session.engine.state.entities.find(entity => entity.id === 's-01')!.taken = true;
  session.engine.state.robot.inventory.push('s-01'); session.engine.observe();
  const directory = await mkdtemp(join(tmpdir(), 'oxygen-budget-closing-'));
  session.journal = new SessionJournal(directory);
  t.after(async () => { await session.stop(); await session.journal!.flush(); await rm(directory, { recursive: true, force: true }); });
  const command = '修好我的供氧管';
  await session.command(command, { x: 6, y: 1 });
  await waitFor(session, () => !!session.pendingAuthorization);
  await session.authorize(session.pendingAuthorization!.id, true); await session.settled();
  assert.equal(session.task?.status, 'completed'); assert.equal(session.running, false);
  assert.equal(session.engine.state.phase, 'awaiting_command');
  assert.equal(session.engine.state.elapsedTU, custom.rules.actionCosts.repair_human.tu);
  assert.equal(session.engine.state.human.oxygenRate, custom.rules.repairedOxygenRate);
  assert.equal(session.engine.state.ledger.length, 1); assert.equal(session.metrics.requests, 2);
  assert.equal(session.metrics.skippedTools, 2); assert.equal(contexts.length, 2);
  assert.deepEqual(getCurrentTools(contexts[1].messages).map(tool => tool.name), ['report', 'finish_task']);
  const state = snapshot(contexts[1]);
  assert.equal(state.task.text, command); assert.deepEqual(state.task.selected, { x: 6, y: 1 });
  assert.equal(state.closingTurn, true); assert.equal(state.remainingTU, 0); assert.equal(state.remainingRequests, 0);
  assert.equal(state.telemetry.human.oxygenRate, custom.rules.repairedOxygenRate);
  assert.ok(contexts[1].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(command)));
  assert.ok(contexts[1].messages.some(message => message.role === 'toolResult' && message.toolName === 'interact' && JSON.stringify(message.content).includes('oxygenRate')));
  assert.ok(!JSON.stringify(contexts[1]).includes('s-04'));
  const logs = await readdir(join(directory, 'models'));
  const file = logs.find(name => name.startsWith('000002') && name.endsWith('.context.json'));
  assert.ok(file);
  const closingLog = JSON.parse(await readFile(join(directory, 'models', file), 'utf8'));
  assert.equal(closingLog.metadata.closingTurn, true);
  assert.deepEqual(closingLog.context.tools.map((tool: { name: string }) => tool.name), ['report', 'finish_task']);
});

test('请求预算耗尽最多额外一轮，纯报告或无工具收尾后取消委托，新指令恢复完整工具和预算', async () => {
  for (const closing of [[], [report]]) {
    const custom = structuredClone(level); custom.entities = []; custom.rules.requestLimit = 1;
    const { session, contexts } = scripted([[move(3)], closing, [move(4), finish]], custom);
    await session.command('前往 (4,9)，再返回'); await session.settled();
    assert.equal(contexts.length, 2); assert.equal(session.metrics.requests, 2);
    assert.equal(session.task, null); assert.equal(session.running, false);
    assert.equal(session.engine.state.elapsedTU, 1); assert.equal(session.engine.state.ledger.length, 1);
    assert.equal(snapshot(contexts[1]).remainingTU, custom.rules.actionTULimit - 1);
    assert.equal(snapshot(contexts[1]).task.text, '前往 (4,9)，再返回');
    await session.command('前往 (4,9)'); await session.settled();
    assert.equal(contexts.length, 3); assert.equal(session.metrics.requests, 3);
    assert.ok(getCurrentTools(contexts[2].messages).some(tool => tool.name === 'move_to'));
    assert.equal(snapshot(contexts[2]).closingTurn, undefined);
    assert.equal(snapshot(contexts[2]).remainingTU, custom.rules.actionTULimit);
    assert.equal(session.view().task?.status, 'completed'); assert.equal(session.engine.state.elapsedTU, 2);
  }
});

test('剩余 TU 不足完整动作时，收尾中伪造的移动、维修、查询、询问均不能执行或触发授权', async () => {
  const custom = structuredClone(level); custom.entities = [];
  custom.rules.actionTULimit = 5; custom.rules.actionCosts.move.tu = 3;
  const { session, contexts } = scripted([
    [move(5)],
    [move(5), { name: 'interact', arguments: { operation: 'repair', targetId: 'human' } }, { name: 'get_status', arguments: {} }, { name: 'ask_player', arguments: { question: '继续吗？' } }, report],
    [move(5)],
  ], custom);
  await session.command('前往 (5,9)'); await session.settled();
  assert.equal(contexts.length, 2); assert.equal(session.metrics.requests, 2);
  assert.equal(snapshot(contexts[1]).remainingTU, 2);
  assert.match(snapshot(contexts[1]).budgetStopReason, /下一完整动作需要 3 TU/);
  assert.deepEqual(getCurrentTools(contexts[1].messages).map(tool => tool.name), ['report', 'finish_task']);
  assert.deepEqual(session.engine.state.robot.position, { x: 3, y: 9 });
  assert.equal(session.engine.state.elapsedTU, 3); assert.equal(session.engine.state.ledger.length, 1);
  assert.equal(session.engine.state.robot.battery, custom.rules.battery - custom.rules.actionCosts.move.battery);
  assert.equal(session.engine.state.human.oxygen, custom.rules.oxygen - 3 * custom.rules.oxygenRate);
  assert.equal(session.pendingAuthorization, null); assert.equal(session.pendingRouteSelection, null);
  assert.equal(session.task, null); assert.ok(!session.messages.some(message => message.text === '继续吗？'));
  const partial = contexts[1].messages.find(message => message.role === 'toolResult' && message.toolName === 'move_to');
  assert.ok(partial && partial.role === 'toolResult');
  const payload = partial.content.find(block => block.type === 'text');
  assert.ok(payload?.type === 'text'); assert.equal(JSON.parse(payload.text).targetReached, false);
});

test('停止、手动接管、切换模型或新指令可以取消收尾请求，旧结果不能补执行或覆盖新委托', async () => {
  for (const interruption of ['stop', 'manual', 'model', 'command']) {
    const custom = structuredClone(level); custom.entities = []; custom.rules.requestLimit = 1;
    let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
    let requests = 0;
    const session = new GameSession(custom, { delayMs: 0, adapter: { mode: 'live', label: 'cancel closing', model: demoModel,
      streamFn: (_model, _context, options) => {
        requests++;
        if (requests === 1) return toolStream([move(3)]);
        if (requests > 2) return toolStream([finish]);
        arrived();
        return new Promise<ReturnType<typeof toolStream>>(resolve => {
          const abort = () => resolve(toolStream([move(5), finish]));
          if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    } });
    await session.command('旧委托'); await arrival;
    const restored = new GameSession(custom, { adapter: session.adapter, id: session.id, delayMs: 0 });
    await restored.restore({ ...session.save(), modelConfig: undefined });
    assert.equal(restored.running, false); assert.equal(restored.task?.status, 'paused');
    assert.equal(requests, 2);
    if (interruption === 'stop') await session.stop();
    else if (interruption === 'manual') await session.manual({ kind: 'move', target: { x: 2, y: 9 } }, 'manual-after-closing');
    else if (interruption === 'model') await session.configureModel(defaultModelConfig, undefined);
    else await session.command('新委托');
    await session.settled();
    assert.equal(requests, interruption === 'command' ? 3 : 2);
    assert.equal(session.running, false); assert.equal(session.engine.state.elapsedTU, interruption === 'manual' ? 2 : 1);
    assert.deepEqual(session.engine.state.robot.position, { x: interruption === 'manual' ? 2 : 3, y: 9 });
    if (interruption !== 'command') assert.equal(session.task, null);
    else { assert.equal(session.task?.text, '新委托'); assert.equal(session.task?.status, 'completed'); }
  }
});

test('收尾请求失败仍终止，保留已提交动作且不重试或标记完成', async () => {
  const custom = structuredClone(level); custom.entities = []; custom.rules.requestLimit = 1;
  let requests = 0;
  const session = new GameSession(custom, { delayMs: 0, adapter: { mode: 'live', label: 'failed closing', model: demoModel,
    streamFn: () => { if (++requests === 1) return toolStream([move(3)]); throw new Error('network failure'); },
  } });
  await session.command('前往 (5,9)'); await session.settled();
  assert.equal(requests, 2); assert.equal(session.running, false); assert.equal(session.task, null);
  assert.equal(session.engine.state.elapsedTU, 1); assert.equal(session.engine.state.ledger.length, 1);
  assert.equal(session.engine.state.phase, 'awaiting_command');
});

test('路径新危险和游戏失败即使同时耗尽预算也不追加收尾', async () => {
  for (const cause of ['hazard', 'failure', 'finish']) {
    const custom = structuredClone(level); custom.rules.requestLimit = 1;
    if (cause === 'hazard') custom.entities = [{ id: 'new-hazard', name: '新线路', type: 'hazard', position: { x: 4, y: 9 }, reflection: 2 }];
    if (cause === 'failure') custom.rules.oxygen = custom.rules.oxygenRate;
    const { session, contexts } = scripted([cause === 'finish' ? [finish] : [move(5)]], custom);
    session.engine.state.circuitOn = cause === 'hazard';
    await session.command('调查附近'); await session.settled();
    assert.equal(contexts.length, 1, cause); assert.equal(session.metrics.requests, 1, cause);
    if (cause === 'hazard') assert.equal(session.task, null);
    if (cause === 'failure') assert.equal(session.engine.state.phase, 'failure');
    if (cause === 'finish') assert.equal(session.task?.status, 'completed');
  }
});
