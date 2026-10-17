import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadLevels } from '../apps/server/src/levels.ts';
import { createAppServer } from '../apps/server/src/server.ts';
import { GameSession } from '../apps/server/src/session.ts';
import type { SessionSave, SessionView } from '../apps/server/src/session.ts';
import { parseDemoCommand } from '../apps/server/src/demo-task.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import type { Action, Level, PlayerView } from '../packages/game-core/src/types.ts';
import { verifyLevelRoute } from '../packages/game-core/src/verify-level.ts';

const source = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
const template = validateLevel(JSON.parse(await readFile(new URL('../docs/level-template.json', import.meta.url), 'utf8')));
function map(id: string, width: number, height: number): Level {
  return validateLevel({
    ...source, id, version: 1, name: `测试地图 ${id}`, width, height,
    tiles: Array.from({ length: height }, (_, y) => y === 0 || y === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`),
    humanStart: { x: 1, y: 1 }, robotStart: { x: 2, y: 1 }, exit: { x: width - 2, y: height - 2 },
    rooms: [{ name: '北侧动力舱', bounds: { minX: 1, minY: 1, maxX: width - 2, maxY: height - 2 } }],
    entities: [
      { id: 'kit-a', type: 'supply', itemType: 'repair', name: '维修包甲', reflection: 1, position: { x: 3, y: 1 } },
      { id: 'kit-b', type: 'supply', itemType: 'repair', name: '维修包乙', reflection: 1, position: { x: 2, y: 2 } },
      { id: 'control', type: 'airlock', name: '独立控制器', reflection: 2, position: { x: width - 3, y: height - 3 } },
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
  const replay = await next.call<PlayerView[]>(`${path}/replay`);
  assert.equal(replay.status, 200); assert.equal(replay.data[0].level.width, 16); assert.deepEqual(replay.data.at(-1)!.robot.position, moved.robot.position);
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
