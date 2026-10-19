import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createAppServer } from '../apps/server/src/server.ts';
import type { SessionView } from '../apps/server/src/session.ts';
import type { ReplayView } from '../packages/game-core/src/types.ts';
import type { JournalEntry } from '../apps/server/src/journal.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { runRescueRoute } from '../scripts/routes.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
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

test('仅提供选定的三首 WAV 音乐，并使用正确的音频类型', async t => {
  const { base } = await fixture(t);
  for (const track of ['bgm-exploration', 'rescue-success', 'mission-failure']) {
    const response = await fetch(`${base}/audio/${track}.wav`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  }
  assert.equal((await fetch(`${base}/audio/bgm-critical.wav`)).status, 404);
  assert.equal((await fetch(`${base}/audio/README.md`)).status, 404);
});

test('每局仅保存游戏快照和统一日志，恢复后继续追加并保留旧日志', async t => {
  const { call, sessions, savesDir, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '前往 (3,9)' });
  await sessions.get(initial.sessionId)!.settled();
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const directory = join(savesDir, initial.sessionId);
  assert.deepEqual((await readdir(directory)).sort(), ['events.jsonl', 'game.json']);
  const game = await readFile(join(directory, 'game.json'), 'utf8');
  assert.ok(game.includes('\n  "version"')); assert.equal(JSON.parse(game).engine.elapsedTU, 1);
  const eventsBefore = await readFile(join(directory, 'events.jsonl'), 'utf8');
  const before = eventsBefore.trim().split('\n').map(line => JSON.parse(line) as JournalEntry);
  const firstRequest = before.find(entry => entry.type === 'model_request');
  assert.ok(firstRequest && firstRequest.type === 'model_request');
  assert.ok(JSON.stringify(firstRequest).includes('local-demo'));
  // Existing Markdown files remain intact when an old game is resumed.
  await writeFile(join(directory, 'events.md'), '旧日志\n', 'utf8');
  const loaded = await call(`${path}/load`, {}); assert.equal(loaded.status, 200);
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: loaded.data.stateRevision, text: '前往 (3,8)' });
  await sessions.get(initial.sessionId)!.settled();
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const eventsAfter = await readFile(join(directory, 'events.jsonl'), 'utf8');
  assert.ok(eventsAfter.startsWith(eventsBefore)); assert.ok(eventsAfter.includes('前往 (3,8)'));
  const requests = eventsAfter.trim().split('\n').map(line => JSON.parse(line) as JournalEntry).filter(entry => entry.type === 'model_request');
  assert.equal(requests.length, 2); assert.equal(new Set(requests.map(entry => entry.requestId)).size, 2);
  assert.equal(await readFile(join(directory, 'events.md'), 'utf8'), '旧日志\n');
  assert.deepEqual((await readdir(directory)).sort(), ['events.jsonl', 'events.md', 'game.json']);
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

test('HTTP 按标记 ID 移除，校验版本与参数、去重并同步 SSE 和存档', async t => {
  const { call, initial, sessions, base } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  const add = (revision: number, note: string, shared: boolean) => call(`${path}/marker`, { requestId: crypto.randomUUID(), expectedRevision: revision, position: { x: 4, y: 7 }, note, shared });
  const first = await add(0, '待移除的共享标记', true); assert.equal(first.status, 200);
  const second = await add(1, '保留的私有标记', false); assert.equal(second.status, 200);
  const markerId = first.data.markers[0].id;
  for (const invalid of [undefined, 42, 'not-an-id']) {
    assert.equal((await call(`${path}/remove-marker`, { requestId: crypto.randomUUID(), expectedRevision: 2, markerId: invalid })).status, 400);
  }
  const request = { requestId: crypto.randomUUID(), expectedRevision: 2, markerId };
  assert.equal((await call(`${path}/remove-marker`, { ...request, requestId: crypto.randomUUID(), expectedRevision: 1 })).status, 409);
  assert.equal((await call(`${path}/remove-marker`, { ...request, requestId: crypto.randomUUID(), markerId: crypto.randomUUID() })).status, 400);
  const controller = new AbortController();
  const response = await fetch(`${base}${path}/events`, { signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read();
  try {
    const removed = await call(`${path}/remove-marker`, request);
    assert.equal(removed.status, 200); assert.equal(removed.data.stateRevision, 3);
    assert.deepEqual(removed.data.markers, [second.data.markers[1]]);
    assert.deepEqual(sessions.get(initial.sessionId)!.engine.state.knowledge.markers, []);
    const chunk = await reader.read();
    const event = new TextDecoder().decode(chunk.value).split('\n').find(line => line.startsWith('data:'))!;
    assert.deepEqual(JSON.parse(event.slice(5)).markers, removed.data.markers);
    const duplicate = await call(`${path}/remove-marker`, request);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.data.stateRevision, 3);
    assert.equal((await call(`${path}/remove-marker`, { ...request, requestId: crypto.randomUUID(), expectedRevision: 3 })).status, 400);
    assert.equal(removed.data.elapsedTU, initial.elapsedTU);
    assert.equal(removed.data.human.oxygen, initial.human.oxygen);
    assert.equal(removed.data.robot.battery, initial.robot.battery);
    await call(`${path}/save`, { requestId: crypto.randomUUID() });
    const restored = await call(`${path}/load`, {});
    assert.equal(restored.status, 200); assert.deepEqual(restored.data.markers, removed.data.markers);
    assert.deepEqual(sessions.get(initial.sessionId)!.engine.state.knowledge.markers, []);
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
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

test('恢复存档结束该实例的所有 SSE，重连以新实例完整状态开始且继续收到动作', async t => {
  const { base, call, initial, sessions } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  const other = (await call('/api/sessions', {})).data;
  const previous = sessions.get(initial.sessionId)!;
  previous.eventId = 100;
  const controller = new AbortController();
  t.after(() => controller.abort());
  async function subscribe(id: string, lastEventId = '') {
    const response = await fetch(`${base}/api/sessions/${id}/events`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      headers: { 'Last-Event-ID': lastEventId },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    async function next(): Promise<SessionView | null> {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = event.split('\n').find(line => line.startsWith('data:'));
          if (!data) continue;
          const view = JSON.parse(data.slice(5)) as SessionView;
          assert.ok(event.startsWith(`id: ${view.sessionInstanceId}:${view.eventId}\n`));
          return view;
        }
        const chunk = await reader.read(); if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    return { next, view: (await next())! };
  }
  const tabs = await Promise.all([subscribe(initial.sessionId), subscribe(initial.sessionId)]);
  const untouched = await subscribe(other.sessionId);
  const loaded = await call(`${path}/load`, {});
  assert.equal(loaded.status, 200);
  assert.notEqual(loaded.data.sessionInstanceId, initial.sessionInstanceId);
  assert.ok(loaded.data.eventId < tabs[0].view.eventId);
  await Promise.all(tabs.map(async tab => { while (await tab.next()) { /* Drain final old events until EOF. */ } }));
  assert.equal(previous.listeners.size, 1); // Only the persistence listener remains.
  const resumed = await subscribe(initial.sessionId, `${initial.sessionInstanceId}:100`);
  assert.deepEqual(resumed.view, loaded.data);
  const moved = await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: loaded.data.stateRevision, action: { kind: 'move', target: { x: 3, y: 9 } } });
  assert.equal(moved.status, 200);
  let event = await resumed.next();
  while (event && event.eventId < moved.data.eventId) event = await resumed.next();
  assert.deepEqual(event, moved.data);
  const otherMoved = await call(`/api/sessions/${other.sessionId}/action`, { requestId: crypto.randomUUID(), expectedRevision: other.stateRevision, action: { kind: 'move', target: { x: 3, y: 9 } } });
  assert.equal(otherMoved.status, 200);
  const otherEvent = await untouched.next();
  assert.equal(otherEvent?.sessionInstanceId, other.sessionInstanceId);
  assert.equal(otherEvent?.stateRevision, otherMoved.data.stateRevision);
});

test('HTTP 请求去重按会话实例隔离，恢复后不会返回旧实例缓存', async t => {
  const { call, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  const requestId = crypto.randomUUID();
  const first = await call(`${path}/marker`, { requestId, expectedRevision: 0, position: { x: 3, y: 9 }, note: '恢复前', shared: false });
  assert.equal(first.status, 200);
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const restored = await call(`${path}/load`, {});
  const input = { requestId, expectedRevision: restored.data.stateRevision, position: { x: 3, y: 8 }, note: '恢复后', shared: false };
  const marked = await call(`${path}/marker`, input);
  assert.equal(marked.status, 200);
  assert.equal(marked.data.sessionInstanceId, restored.data.sessionInstanceId);
  assert.equal(marked.data.stateRevision, restored.data.stateRevision + 1);
  assert.deepEqual(marked.data.markers.map(marker => marker.note), ['恢复前', '恢复后']);
  assert.deepEqual((await call(`${path}/marker`, input)).data, marked.data);
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
  const replay = await call<ReplayView>(`${path}/replay`); assert.equal(replay.status, 200);
  assert.equal(replay.data.state.elapsedTU, 0); assert.ok(!JSON.stringify(replay.data.state).includes('s-04'));
  assert.equal(replay.data.total, route.state.ledger.length);
  const end = (await call<ReplayView>(`${path}/replay?step=${replay.data.total}`)).data.state;
  assert.equal(end.phase, 'success'); assert.equal(end.elapsedTU, view.elapsedTU); assert.equal(end.human.oxygen, view.human.oxygen);
});

test('HTTP 回溯按指定步数返回当时知识和资源，校验范围且不改变实时对局', async t => {
  const { call, sessions, initial } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`;
  assert.equal((await call<ReplayView>(`${path}/replay`)).data.total, 0);
  for (const [index, target] of [{ x: 3, y: 9 }, { x: 3, y: 8 }].entries()) {
    assert.equal((await call(`${path}/action`, { requestId: crypto.randomUUID(), expectedRevision: index, action: { kind: 'move', target } })).status, 200);
  }
  const session = sessions.get(initial.sessionId)!; const before = session.save();
  const middle = await call<ReplayView>(`${path}/replay?step=1`);
  assert.equal(middle.status, 200); assert.equal(middle.data.step, 1); assert.equal(middle.data.total, 2);
  assert.deepEqual(middle.data.state.robot.position, { x: 3, y: 9 });
  assert.equal(middle.data.state.human.oxygen, 118); assert.equal(middle.data.state.ledger.length, 1);
  assert.equal(middle.data.entries.length, 2); assert.ok(!JSON.stringify(middle.data.state).includes('s-04'));
  for (const step of ['-1', '3', '1.5', 'abc', '', 'Infinity', '9007199254740992']) assert.equal((await call(`${path}/replay?step=${step}`)).status, 400, step);
  assert.deepEqual(session.save(), before);
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

test('HTTP 选路同步候选路径、校验与去重，选带电路线后拒绝授权立即停止', async t => {
  const { call, sessions, initial, base } = await fixture(t);
  const path = `/api/sessions/${initial.sessionId}`; const session = sessions.get(initial.sessionId)!;
  session.engine.state.circuitOn = true;
  session.engine.state.entities.find(entity => entity.id === 'd-01')!.opened = true;
  for (const position of [{ x: 6, y: 2 }, { x: 6, y: 3 }, { x: 7, y: 3 }]) {
    session.engine.state.robot.position = position; session.engine.observe();
  }
  session.adapter = { mode: 'live', label: '选路测试', model: demoModel, streamFn: () => toolStream([
    { name: 'move_to', arguments: { target: { x: 9, y: 3 } } },
    { name: 'finish_task', arguments: { reason: '完成。' } },
  ]) };
  session.agent.streamFunction = session.adapter.streamFn;
  await call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '前往 (9,3)' });
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${base}${path}/events`, { signal: controller.signal });
  const reader = response.body!.getReader(); let sse = '';
  while (!sse.includes('"pendingRouteSelection":{"id"')) sse += new TextDecoder().decode((await reader.read()).value);
  assert.ok(sse.includes('estimatedCost')); assert.ok(sse.includes(session.pendingRouteSelection!.id));
  controller.abort(); await reader.cancel().catch(() => undefined);
  const selectionId = session.pendingRouteSelection!.id;
  assert.equal((await call(path)).data.pendingRouteSelection?.options.length, 2);
  for (const invalid of [{ selectionId, choice: 'anything' }, { selectionId: 'bad-id', choice: 'safe' }, { choice: 'safe' }]) {
    assert.equal((await call(`${path}/select-route`, { requestId: crypto.randomUUID(), ...invalid })).status, 400);
  }
  const input = { requestId: crypto.randomUUID(), selectionId, choice: 'shortest' };
  assert.equal((await call(`${path}/select-route`, input)).status, 200);
  assert.equal((await call(`${path}/select-route`, input)).status, 200);
  assert.equal((await call(`${path}/select-route`, { ...input, requestId: crypto.randomUUID() })).status, 409);
  const pending = (await call(path)).data.pendingAuthorization!;
  assert.equal(pending.kind, 'hazard'); assert.equal(session.engine.state.elapsedTU, 0);
  assert.equal((await call(`${path}/authorize`, { requestId: crypto.randomUUID(), authorizationId: pending.id, approve: false })).status, 200);
  await session.settled();
  const latest = (await call(path)).data;
  assert.equal(latest.running, false); assert.equal(latest.task, null); assert.equal(latest.phase, 'awaiting_command'); assert.equal(latest.elapsedTU, 0);
  assert.equal(latest.metrics.requests, 1); assert.equal(latest.pendingRouteSelection, null); assert.equal(latest.pendingAuthorization, null);
  assert.equal((await call(`${path}/continue`, { requestId: crypto.randomUUID(), expectedRevision: latest.stateRevision })).status, 404);
  assert.equal(session.metrics.requests, 1); assert.equal(session.task, null);
  await call(`${path}/save`, { requestId: crypto.randomUUID() });
  const loaded = await call(`${path}/load`, {});
  assert.equal(loaded.data.task, null);
  assert.equal((await call(`${path}/continue`, { requestId: crypto.randomUUID(), expectedRevision: loaded.data.stateRevision })).status, 404);
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.task, null);
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
