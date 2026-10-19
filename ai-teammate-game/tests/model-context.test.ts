import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AgentMessage } from '../../pi-main/packages/agent/dist/index.js';
import { GameSession } from '../apps/server/src/session.ts';
import { defaultModelConfig, demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ModelAdapter, ToolIntent } from '../apps/server/src/model.ts';
import { GameEngine } from '../packages/game-core/src/engine.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { ObservedEntity, Position, RadarEcho } from '../packages/game-core/src/types.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
const finish: ToolIntent = { name: 'finish_task', arguments: { reason: '本次检查结束。' } };
const scan: ToolIntent = { name: 'scan', arguments: { targetId: 'c-01' } };
const move = (x: number, y: number): ToolIntent => ({ name: 'move_to', arguments: { target: { x, y } } });
function snapshot(engine: GameEngine) {
  return engine.robotContext() as {
    knownEntities: (ObservedEntity & { interaction: { distance: number; inSensorRange: boolean; canScan: boolean; reason: string | null; approachPositions: { position: Position; steps: number }[] } })[];
    radar: RadarEcho[]; unidentifiedRadar: RadarEcho[]; identifiedRadar: { echoId: string; knownEntityIds: string[] }[];
  };
}
function scripted(rounds: ToolIntent[][], id?: string) {
  const contexts: { messages: AgentMessage[] }[] = [];
  const adapter: ModelAdapter = { mode: 'live', label: 'scripted live model', model: demoModel,
    config: { ...defaultModelConfig, mode: 'live' }, ready: true,
    streamFn: (_model, context) => { contexts.push(structuredClone({ messages: context.messages })); return toolStream(rounds.shift() ?? []); },
  };
  const custom = structuredClone(level); custom.robotStart = { x: 4, y: 3 };
  return { session: new GameSession(custom, { adapter, delayMs: 0, id }), contexts };
}
function knowledge(context: { messages: AgentMessage[] }) {
  const system = context.messages[0]; assert.equal(system.role, 'system');
  assert.ok(system.role === 'system');
  assert.ok(typeof system.content === 'string');
  return JSON.parse(system.content.split('当前机器人知识与任务（仅可见事实）：\n')[1]);
}
function userText(message: AgentMessage): string {
  assert.ok(message.role === 'user');
  return typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
}

test('已知柜子的距离和可检查条件匹配引擎，斜对角失败明确解释且不扣资源', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 4, y: 3 };
  const engine = new GameEngine(custom);
  for (const [x, y, expectedDistance] of [[4, 2, 2], [4, 4, 2], [3, 4, 3]]) {
    engine.state.robot.position = { x, y };
    const info = snapshot(engine).knownEntities.find(entity => entity.id === 'c-01')!.interaction;
    assert.equal(info.distance, expectedDistance); assert.equal(info.inSensorRange, false); assert.equal(info.canScan, false);
    const before = engine.snapshot();
    const result = engine.perform({ kind: 'scan', targetId: 'c-01' });
    assert.equal(result.code, 'OUT_OF_RANGE'); assert.match(result.message, /\(5,3\)/);
    assert.ok(result.message.includes(`(${x},${y})`)); assert.ok(result.message.includes(`当前距离 ${expectedDistance}`));
    assert.match(result.message, /斜对角不算/);
    assert.equal(engine.state.elapsedTU, before.elapsedTU); assert.deepEqual(engine.state.robot, before.robot); assert.deepEqual(engine.state.human, before.human);
  }
  engine.state.robot.position = { x: 4, y: 3 };
  const { approachPositions, ...interaction } = snapshot(engine).knownEntities.find(entity => entity.id === 'c-01')!.interaction;
  assert.deepEqual(interaction, { distance: 1, inSensorRange: true, canScan: true, reason: null });
  assert.deepEqual(approachPositions[0], { position: { x: 4, y: 3 }, steps: 0 });
  assert.equal(engine.perform({ kind: 'scan', targetId: 'c-01' }).accepted, true);
  assert.ok(!JSON.stringify(engine.robotContext()).includes('s-04'));
});

test('感知范围与交互距离分别计算，背包和已消耗物资不能按历史坐标再次检查', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 3, y: 3 }; custom.rules.sensorRadius = 3;
  const engine = new GameEngine(custom);
  const info = snapshot(engine).knownEntities.find(entity => entity.id === 'c-01')!.interaction;
  assert.equal(info.distance, 2); assert.equal(info.inSensorRange, true); assert.equal(info.canScan, false);
  const supply = engine.state.entities.find(entity => entity.id === 's-03')!;
  supply.taken = true; engine.state.robot.inventory.push(supply.id); engine.observe();
  let observed = snapshot(engine).knownEntities.find(entity => entity.id === supply.id)!;
  assert.equal(observed.interaction.canScan, false); assert.match(observed.interaction.reason!, /背包.*历史/);
  assert.deepEqual(observed.interaction.approachPositions, []);
  supply.taken = false; supply.removed = true; engine.state.robot.inventory = []; engine.observe();
  observed = snapshot(engine).knownEntities.find(entity => entity.id === supply.id)!;
  assert.equal(observed.interaction.canScan, false); assert.match(observed.interaction.reason!, /消耗/);
  assert.deepEqual(observed.interaction.approachPositions, []);
});

test('门的可接近位置排除上下墙格和门本体，最近候选为一步外的左侧，查询不改变对局', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 6, y: 3 };
  const engine = new GameEngine(custom);
  assert.equal(engine.perform({ kind: 'move', target: { x: 6, y: 2 } }).accepted, true);
  const before = engine.snapshot();
  const context = snapshot(engine);
  const candidates = context.knownEntities.find(entity => entity.id === 'd-01')!.interaction.approachPositions;
  assert.deepEqual(candidates[0], { position: { x: 6, y: 3 }, steps: 1 });
  for (const { position, steps } of candidates) {
    assert.ok(!(position.x === 7 && [2, 3, 4].includes(position.y)));
    assert.equal(Math.abs(position.x - 7) + Math.abs(position.y - 3), 1);
    assert.ok(steps >= 1);
  }
  assert.deepEqual(engine.snapshot(), before);
  assert.ok(!JSON.stringify(context).includes('h-01'));
  assert.equal(engine.perform({ kind: 'move', target: candidates[0].position }).accepted, true);
  engine.state.circuitOn = true;
  assert.equal(engine.perform({ kind: 'open', targetId: 'd-01' }).accepted, true);
});

test('可接近位置只使用已知阻挡，观察和清理后重新计算，不提前泄露未知障碍', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 6, y: 3 };
  custom.entities.find(entity => entity.id === 'o-01')!.position = { x: 8, y: 3 };
  const engine = new GameEngine(custom);
  engine.state.robot.position = { x: 6, y: 2 }; engine.observe();
  const candidates = () => snapshot(engine).knownEntities.find(entity => entity.id === 'd-01')!.interaction.approachPositions;
  const hasEast = () => candidates().some(candidate => candidate.position.x === 8 && candidate.position.y === 3);
  assert.equal(hasEast(), true);
  assert.ok(!JSON.stringify(engine.robotContext()).includes('o-01'));
  engine.state.robot.position = { x: 8, y: 4 }; engine.observe();
  engine.state.robot.position = { x: 6, y: 2 };
  assert.equal(hasEast(), false);
  engine.state.robot.position = { x: 8, y: 4 };
  assert.equal(engine.perform({ kind: 'clear', targetId: 'o-01' }).accepted, true);
  engine.state.robot.position = { x: 6, y: 2 };
  assert.equal(hasEast(), true);
  engine.state.circuitOn = true;
  assert.equal(hasEast(), false);
});

test('物资允许同格零步交互，候选排除墙和喷气出口，修复后出口可作为候选', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 10, y: 2 };
  custom.entities.find(entity => entity.id === 's-03')!.position = { ...custom.robotStart };
  const engine = new GameEngine(custom);
  const candidates = () => snapshot(engine).knownEntities.find(entity => entity.id === 's-03')!.interaction.approachPositions;
  const hasExit = () => candidates().some(candidate => candidate.position.x === 10 && candidate.position.y === 1);
  assert.deepEqual(candidates()[0], { position: { x: 10, y: 2 }, steps: 0 });
  assert.equal(hasExit(), false);
  assert.ok(candidates().every(candidate => candidate.position.x < 11));
  engine.state.entities.find(entity => entity.type === 'airlock')!.repaired = true;
  assert.equal(hasExit(), true);
});

test('回波按已有观察关联，未知列表不包含已知柜子，也不泄露未知开关或柜内物资身份', () => {
  const custom = structuredClone(level); custom.robotStart = { x: 4, y: 3 };
  const engine = new GameEngine(custom);
  let context = snapshot(engine);
  const cabinetEcho = context.radar.find(echo => echo.position.x === 5 && echo.position.y === 3)!;
  const switchEcho = context.radar.find(echo => echo.position.x === 6 && echo.position.y === 1)!;
  assert.ok(cabinetEcho); assert.ok(switchEcho);
  assert.deepEqual(context.radar, engine.playerView().radar);
  assert.deepEqual(context.identifiedRadar.find(echo => echo.echoId === cabinetEcho.id)?.knownEntityIds, ['c-01']);
  assert.ok(!context.unidentifiedRadar.some(echo => echo.id === cabinetEcho.id));
  assert.ok(context.unidentifiedRadar.some(echo => echo.id === switchEcho.id));
  assert.ok(!JSON.stringify(context).includes('sw-01')); assert.ok(!JSON.stringify(context).includes('s-04'));
  for (const target of [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 6, y: 2 }]) assert.equal(engine.perform({ kind: 'move', target }).accepted, true);
  context = snapshot(engine);
  assert.ok(!context.unidentifiedRadar.some(echo => echo.id === switchEcho.id));
  assert.deepEqual(context.identifiedRadar.find(echo => echo.echoId === switchEcho.id)?.knownEntityIds, ['sw-01']);
});

test('多轮裁剪始终保留本条原始指令、完整工具配对，以及早期失败和关键动作', async () => {
  const { session, contexts } = scripted([
    [move(4, 2)], [scan], [move(4, 3), scan],
    [move(4, 2)], [move(4, 3)], [move(4, 2)], [move(4, 3)], [move(4, 2)], [finish],
  ]);
  const instruction = '继续探索附近几个未知雷达物体，不要开启电路';
  await session.command(instruction); await session.settled();
  assert.equal(contexts.length, 9); assert.equal(session.modelError, null);
  for (const context of contexts) {
    const users = context.messages.filter(message => message.role === 'user');
    assert.equal(users.length, 1); assert.equal(userText(users[0]), instruction);
    for (const message of context.messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.content.filter(block => block.type === 'toolCall')) {
        assert.ok(context.messages.some(result => result.role === 'toolResult' && result.toolCallId === call.id));
      }
    }
  }
  const last = knowledge(contexts.at(-1)!);
  assert.equal(contexts.at(-1)!.messages.filter(message => message.role === 'assistant').length, 5);
  assert.equal(last.task.text, instruction);
  assert.deepEqual(last.taskProgress.newDiscoveries, []);
  assert.equal(last.taskProgress.recentActions[0].action.kind, 'scan');
  assert.equal(last.taskProgress.recentMoves.length, 5);
  const failure = last.taskProgress.recentFailures[0];
  assert.equal(failure.tool, 'scan'); assert.deepEqual(failure.arguments, { targetId: 'c-01' });
  assert.deepEqual(failure.position, { x: 4, y: 2 }); assert.equal(failure.code, 'OUT_OF_RANGE');
  assert.match(failure.message, /当前距离 2/);
  const actualResults = contexts.at(-1)!.messages.filter(message => message.role === 'toolResult');
  assert.ok(actualResults.every(result => !JSON.stringify(result.content).includes('OUT_OF_RANGE')));
});

test('本次新发现与原来已知对象分开，get_status 同步进展，新委托不沿用旧指令或失败', async () => {
  const { session, contexts } = scripted([[move(6, 2)], [move(6, 3)], [{ name: 'get_status', arguments: {} }, finish], [finish]]);
  await session.command('继续探索附近几个未知雷达物体'); await session.settled();
  const progress = knowledge(contexts[2]).taskProgress;
  assert.deepEqual(progress.newDiscoveries.map((entity: ObservedEntity) => entity.id).sort(), ['d-01', 'sw-01']);
  const status = session.agent.state.messages.find(message => message.role === 'toolResult' && message.toolName === 'get_status');
  assert.ok(status?.role === 'toolResult' && status.content[0].type === 'text');
  assert.deepEqual(JSON.parse(status.content[0].text).taskProgress, progress);
  assert.equal(session.engine.state.elapsedTU, 4);
  await session.command('留在这里，不要通电'); await session.settled();
  const latest = contexts.at(-1)!;
  assert.deepEqual(knowledge(latest).taskProgress, { newDiscoveries: [], recentActions: [], recentMoves: [], recentFailures: [] });
  assert.equal(latest.messages.length, 2); assert.equal(userText(latest.messages[1]), '留在这里，不要通电');
});

test('执行记录与完整 AI 消息随当前存档准确保存恢复', async () => {
  const { session } = scripted([[move(4, 2)], [scan], [move(4, 3)], [move(6, 2)], [finish]]);
  await session.command('探索未知回波'); await session.settled();
  const save = session.save();
  assert.ok(save.taskMemory); assert.equal(save.taskMemory.recentFailures.length, 1);
  assert.ok(!save.taskMemory.initialKnownEntityIds.includes('sw-01'));
  const restored = scripted([], session.id).session;
  await restored.restore(save, undefined, true);
  assert.deepEqual(restored.save().taskMemory, save.taskMemory);
  assert.deepEqual(restored.agent.state.messages, save.agentMessages);
});

test('失败执行记录只保留最近五项，长期上下文有界', async () => {
  const { session, contexts } = scripted([
    ...Array.from({ length: 6 }, () => [move(4, 3), move(4, 2), scan]), [finish],
  ]);
  await session.command('核对交互范围'); await session.settled();
  assert.equal(contexts.length, 7);
  assert.equal(session.save().taskMemory!.recentFailures.length, 5);
  assert.equal(knowledge(contexts.at(-1)!).taskProgress.recentFailures.length, 5);
});
