import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createAppServer } from '../apps/server/src/server.ts';
import type { SessionView } from '../apps/server/src/session.ts';
import type { PlayerView } from '../packages/game-core/src/types.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { runRescueRoute } from '../scripts/routes.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
async function fixture(t: TestContext, delayMs = 0) {
  const savesDir = await mkdtemp(join(tmpdir(), 'last-oxygen-'));
  const app = createAppServer(level, { savesDir, delayMs });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.shutdown(); await rm(savesDir, { recursive: true, force: true }); });
  async function call<T = SessionView>(path: string, payload?: unknown) {
    const res = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: res.status, data: await res.json() as T };
  }
  const created = await call('/api/sessions', {}); assert.equal(created.status, 201);
  return { ...app, call, base, savesDir, initial: created.data };
}

test('每局单独目录保存可读对局和完整模型日志，恢复后追加而不覆盖', async t => {
  const { call, sessions, savesDir, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '前往 (3,9)' });
  await sessions.get(initial.sessionId)!.settled();
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const directory = join(savesDir, initial.sessionId);
  assert.ok((await readdir(directory)).includes('game.json'));
  const game = await readFile(join(directory, 'game.json'), 'utf8');
  assert.ok(game.includes('\n  "version"')); assert.equal(JSON.parse(game).engine.elapsedTU, 1);
  const summary = await readFile(join(directory, 'game.md'), 'utf8');
  assert.ok(summary.includes('完整行动账本')); assert.ok(summary.includes('前往 (3,9)'));
  const files = await readdir(join(directory, 'models'));
  const firstLog = files.find(name => name.endsWith('.md'))!;
  const firstContents = await readFile(join(directory, 'models', firstLog), 'utf8');
  assert.ok(firstContents.includes('本地规则') || firstContents.includes('local-demo'));
  const eventsBefore = await readFile(join(directory, 'events.md'), 'utf8');
  const loaded = await call(`${path}/load`, {}); assert.equal(loaded.status, 200);
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: loaded.data.stateRevision, text: '前往 (3,8)' });
  await sessions.get(initial.sessionId)!.settled();
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const after = await readdir(join(directory, 'models'));
  assert.equal(after.filter(name => name.endsWith('.md')).length, 2);
  assert.equal(await readFile(join(directory, 'models', firstLog), 'utf8'), firstContents);
  const eventsAfter = await readFile(join(directory, 'events.md'), 'utf8');
  assert.ok(eventsAfter.startsWith(eventsBefore)); assert.ok(eventsAfter.includes('前往 (3,8)'));
});

test('旧平铺存档仍可列出和恢复，恢复后写入对局目录且不改写旧文件', async t => {
  const { call, sessions, savesDir, initial } = await fixture(t);
  const id = crypto.randomUUID();
  const legacy = JSON.stringify({ ...sessions.get(initial.sessionId)!.save(), id });
  await writeFile(join(savesDir, `${id}.json`), legacy, 'utf8');
  const listed = await call<{ id: string; modified: number }[]>('/api/saves');
  assert.ok(listed.data.some(save => save.id === id));
  assert.equal((await call(`/api/sessions/${id}/load`, {})).status, 200);
  assert.equal(JSON.parse(await readFile(join(savesDir, id, 'game.json'), 'utf8')).id, id);
  assert.equal(await readFile(join(savesDir, `${id}.json`), 'utf8'), legacy);
  const deduplicated = await call<{ id: string; modified: number }[]>('/api/saves');
  assert.equal(deduplicated.data.filter(save => save.id === id).length, 1);
});

test('HTTP 动作去重、版本冲突、并发提交及非法参数都不重复扣资源', async t => {
  const { call, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  const input = { requestId: crypto.randomUUID(), expectedRevision: 0, action: { kind: 'move', target: { x: 3, y: 9 } } };
  const first = await call(`${path}/action`, input); assert.equal(first.status, 200); assert.equal(first.data.elapsedTU, 1);
  const duplicate = await call(`${path}/action`, input); assert.equal(duplicate.data.elapsedTU, 1);
  const stale = await call(`${path}/action`, { ...input, requestId: crypto.randomUUID() }); assert.equal(stale.status, 409);
  const malformed = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 1, action: { kind: 'move', target: { x: '3', y: 8 } } }); assert.equal(malformed.status, 400);
  const concurrent = await Promise.all([0, 1].map(() => call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 1, action: { kind: 'move', target: { x: 3, y: 8 } } })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const final = await call(path); assert.equal(final.data.elapsedTU, 2); assert.equal(final.data.human.oxygen, 116);
  assert.ok(!JSON.stringify(final.data).includes('s-04'));
});

test('HTTP 手动移动不能进入喷气出口，维修后同一出口恢复通行', async t => {
  const { call, sessions, initial } = await fixture(t);
  const session = sessions.get(initial.sessionId)!;
  session.engine.state.robot.position = { x: 10, y: 2 }; session.engine.observe();
  const path = `/api/sessions/${initial.sessionId}/action`;
  const move = () => call(path, { requestId: crypto.randomUUID(), expectedRevision: session.engine.state.stateRevision, allowHazard: true, action: { kind: 'move', target: level.exit } });
  const blocked = await move();
  assert.equal(blocked.data.exitStatus, 'leaking');
  assert.deepEqual(blocked.data.robot.position, { x: 10, y: 2 });
  assert.equal(blocked.data.elapsedTU, 0); assert.equal(blocked.data.robot.battery, initial.robot.battery);
  session.engine.state.robot.position = { x: 9, y: 8 };
  const material = session.engine.state.entities.find(e => e.id === 's-01')!; material.taken = true;
  session.engine.state.robot.inventory.push(material.id); session.engine.observe();
  assert.equal(session.engine.perform({ kind: 'repair', targetId: 'a-01' }).accepted, true);
  session.engine.state.robot.position = { x: 10, y: 2 };
  const allowed = await move();
  assert.equal(allowed.status, 200); assert.equal(allowed.data.exitStatus, 'safe');
  assert.deepEqual(allowed.data.robot.position, level.exit);
});

test('SSE 发送的玩家投影不含隐藏实体，跨来源请求被拒绝', async t => {
  const { base, initial } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/${initial.sessionId}/events`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader(); const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value); assert.ok(text.includes('data:')); assert.ok(!text.includes('s-04')); assert.ok(!text.includes('a-01'));
  controller.abort(); await reader.cancel().catch(() => undefined);
  const foreign = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
});

test('通过 HTTP 完整救援后存档恢复、账本回放与原局的资源和结局一致', async t => {
  const { call, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  const route = runRescueRoute(level, 'upper'); let view = initial;
  for (const entry of route.state.ledger) {
    const result = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: view.stateRevision, action: entry.action });
    assert.equal(result.status, 200); view = result.data;
    assert.equal(view.elapsedTU, entry.elapsedTU); assert.equal(view.human.oxygen, entry.oxygen); assert.equal(view.robot.battery, entry.battery);
  }
  assert.equal(view.phase, 'success');
  await call(`${path}/save`, { requestId: crypto.randomUUID(), expectedRevision: view.stateRevision });
  const loaded = await call(`${path}/load`, {}); assert.equal(loaded.data.phase, 'success'); assert.deepEqual(loaded.data.robot, view.robot);
  const replay = await call<PlayerView[]>(`${path}/replay`); assert.equal(replay.status, 200);
  assert.equal(replay.data[0].elapsedTU, 0); assert.ok(!JSON.stringify(replay.data[0]).includes('s-04'));
  const end = replay.data.at(-1)!; assert.equal(end.phase, 'success'); assert.equal(end.elapsedTU, view.elapsedTU); assert.equal(end.human.oxygen, view.human.oxygen);
});

test('HTTP 前端可切换已知邻接开关，拒绝远程和非法参数且请求去重', async t => {
  const { call, initial, sessions } = await fixture(t);
  const session = sessions.get(initial.sessionId)!;
  const path = `/api/sessions/${initial.sessionId}`;
  for (const action of [{ kind: 'circuit', on: true }, { kind: 'circuit', targetId: 'sw-01', on: 'yes' }]) {
    const result = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 0, action });
    assert.equal(result.status, 400);
  }
  assert.equal(session.engine.state.circuitOn, false);
  assert.equal(session.engine.state.elapsedTU, 0);
  session.engine.state.robot.position = { x: 6, y: 2 }; session.engine.observe();
  const request = { requestId: crypto.randomUUID(), expectedRevision: 0, action: { kind: 'circuit', targetId: 'sw-01', on: true } };
  assert.equal((await call(`${path}/action`, request)).data.circuitOn, true);
  assert.equal((await call(`${path}/action`, request)).data.elapsedTU, 1);
  session.engine.state.robot.position = { x: 6, y: 3 }; session.engine.observe();
  const distant = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 1, action: { kind: 'circuit', targetId: 'sw-01', on: false } });
  assert.equal(distant.data.circuitOn, true); assert.equal(distant.data.elapsedTU, 1);
  session.engine.state.robot.position = { x: 6, y: 2 }; session.engine.observe();
  const off = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: 1, action: { kind: 'circuit', targetId: 'sw-01', on: false } });
  assert.equal(off.data.circuitOn, false); assert.equal(off.data.elapsedTU, 2);
});

test('运行中的存档恢复为暂停，停止请求不因客户端旧版本而失效', async t => {
  const { call, sessions, initial } = await fixture(t, 100);
  const path = `/api/sessions/${initial.sessionId}`;
  const session = sessions.get(initial.sessionId)!;
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '前往 (5,9)' });
  assert.equal(session.running, true);
  const checkpoint = await call(`${path}/save`, { requestId: crypto.randomUUID(), expectedRevision: 0 });
  const loaded = await call(`${path}/load`, {}); assert.equal(loaded.data.phase, 'paused'); assert.equal(loaded.data.running, false);
  assert.equal(loaded.data.task?.status, 'paused'); assert.equal(loaded.data.elapsedTU, checkpoint.data.elapsedTU);
  const stop = await call(`${path}/stop`, { requestId: crypto.randomUUID(), expectedRevision: 0 }); assert.equal(stop.status, 200);
  const latest = await call<SessionView>('/api/latest'); assert.equal(latest.data.sessionId, initial.sessionId);
});

test('HTTP 授权决定按请求 ID 去重，SSE 同步挂起状态且过期授权返回冲突', async t => {
  const { call, sessions, initial, base } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`; const session = sessions.get(initial.sessionId)!;
  const item = session.engine.state.entities.find(e => e.id === 's-01')!;
  item.taken = true; session.engine.state.robot.inventory.push(item.id); session.engine.observe();
  session.adapter = { mode: 'test', label: '授权测试', model: demoModel, streamFn: () => toolStream([
    { name: 'interact', arguments: { operation: 'repair', targetId: 'human' } },
    { name: 'finish_task', arguments: { reason: '完成。' } },
  ]) };
  session.agent.streamFunction = session.adapter.streamFn;
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '检查救援情况' });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { session.listeners.delete(listener); reject(new Error('未收到待授权事件')); }, 1000);
    const listener = () => { if (session.pendingAuthorization) { clearTimeout(timeout); session.listeners.delete(listener); resolve(); } };
    session.listeners.add(listener); listener();
  });
  const controller = new AbortController(); const response = await fetch(`${base}${path}/events`, { signal: controller.signal });
  const reader = response.body!.getReader(); const chunk = await reader.read();
  const sse = new TextDecoder().decode(chunk.value); assert.ok(sse.includes('pendingAuthorization')); assert.ok(sse.includes(session.pendingAuthorization!.id));
  controller.abort(); await reader.cancel().catch(() => undefined);
  const input = { requestId: crypto.randomUUID(), authorizationId: session.pendingAuthorization!.id, approve: true };
  const first = await call(`${path}/authorize`, input); assert.equal(first.status, 200);
  await session.settled(); assert.equal(session.engine.state.elapsedTU, 6); assert.equal(session.metrics.requests, 1);
  assert.equal((await call(`${path}/authorize`, input)).status, 200); assert.equal(session.engine.state.elapsedTU, 6);
  assert.equal((await call(`${path}/authorize`, { ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await call(`${path}/authorize`, { requestId: crypto.randomUUID(), authorizationId: input.authorizationId, approve: 'yes' })).status, 400);
});
