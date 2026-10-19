import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { SessionJournal } from '../apps/server/src/journal.ts';
import type { HistoryView, JournalEntry } from '../apps/server/src/journal.ts';
import { GameSession } from '../apps/server/src/session.ts';
import type { HistoryPreview, SessionView } from '../apps/server/src/session.ts';
import { createAppServer } from '../apps/server/src/server.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { demoModel, toolStream } from '../apps/server/src/model.ts';
import type { ToolIntent } from '../apps/server/src/model.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'oxygen-history-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function server(t: TestContext) {
  const savesDir = await mkdtemp(join(tmpdir(), 'oxygen-history-server-'));
  const app = createAppServer(level, { savesDir, delayMs: 0 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.shutdown(); await rm(savesDir, { recursive: true, force: true }); });
  async function call<T = SessionView>(path: string, payload?: unknown) {
    const res = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: res.status, data: await res.json() as T };
  }
  const initial = (await call('/api/sessions', {})).data;
  const path = `/api/sessions/${initial.sessionId}`;
  const post = (operation: string, view: SessionView, payload: object = {}) => call(`${path}/${operation}`, { requestId: crypto.randomUUID(), expectedRevision: view.stateRevision, expectedInstanceId: view.sessionInstanceId, ...payload });
  return { ...app, call, post, initial, path, savesDir };
}

test('树形 JSONL 精确恢复状态增量、标记 ID、工具消息更新与任意分支', async t => {
  const path = await directory(t);
  const session = new GameSession(level, { delayMs: 0 });
  session.journal = new SessionJournal(path, session.save()); session.checkpoint('初始状态');
  const root = session.view().history.headId!;
  await session.command('前往 (5,9)'); await session.settled();
  const moved = session.save(), movedNode = session.view().history.headId!;
  assert.equal(moved.engine.ledger.length, 3);
  assert.equal(session.view().history.nodes.length, 2); // No intermediate movement nodes.
  session.marker({ x: 5, y: 8 }, '只属于原分支', true);
  const marked = session.save(), markerNode = session.view().history.headId!;
  const marker = session.engine.state.markers[0];
  session.removeMarker(marker.id); await session.settled();
  assert.deepEqual(session.journal.boundarySave(markerNode), json(marked));
  assert.deepEqual(session.journal.boundarySave(movedNode), json(moved));
  assert.deepEqual((await SessionJournal.open(path)).restoreAt(), json(session.save()));

  const current = session.view();
  await session.rewind(root, current.stateRevision, current.sessionInstanceId);
  assert.equal(session.engine.state.elapsedTU, 0); assert.deepEqual(session.engine.state.markers, []);
  assert.deepEqual(session.agent.state.messages, session.journal.boundarySave(root).agentMessages);
  assert.ok(!JSON.stringify(session.messages).includes('只属于原分支'));
  assert.ok(session.engine.state.stateRevision > current.stateRevision);
  assert.notEqual(session.instanceId, current.sessionInstanceId);
  await session.command('前往 (3,8)'); await session.settled();
  const nodes = session.view().history.nodes;
  assert.equal(nodes[nodes.length - 1].parentId, root);
  assert.deepEqual(session.journal.boundarySave(markerNode), json(marked));
  assert.deepEqual((await SessionJournal.open(path)).restoreAt(), json(session.save()));
  assert.deepEqual(await readdir(path), ['session.jsonl']);
});

test('只切换当前节点、不创建新行动，重开文件仍恢复所选节点', async t => {
  const path = await directory(t);
  const session = new GameSession(level, { delayMs: 0 });
  session.journal = new SessionJournal(path, session.save()); session.checkpoint('初始状态');
  const root = session.view().history.headId!;
  await session.command('前往 (5,9)'); await session.settled();
  const before = await readFile(join(path, 'session.jsonl'), 'utf8');
  await session.journal.select(root);
  const reopened = await SessionJournal.open(path);
  assert.equal(reopened.history().headId, root);
  assert.equal(reopened.restoreAt().engine.elapsedTU, 0);
  assert.equal(reopened.history().nodes.length, 2);
  assert.ok((await readFile(join(path, 'session.jsonl'), 'utf8')).startsWith(before));
});

test('JSONL 仅修复未完成的尾行，完整损坏行和错误父节点明确拒绝', async t => {
  const path = await directory(t);
  const journal = new SessionJournal(path, new GameSession(level).save()); journal.boundary('初始状态'); await journal.flush();
  const file = join(path, 'session.jsonl'), complete = await readFile(file, 'utf8');
  await appendFile(file, '{"type":"state","changes":');
  const reopened = await SessionJournal.open(path);
  assert.equal(await readFile(file, 'utf8'), complete);
  await reopened.record('修复后继续', {}); await reopened.flush();
  assert.equal((await SessionJournal.open(path)).restoreAt().engine.elapsedTU, 0);
  await writeFile(file, complete + '{bad json}\n');
  await assert.rejects(SessionJournal.open(path), SyntaxError);
  await writeFile(file, complete + JSON.stringify({ type: 'event', id: crypto.randomUUID(), parentId: 'missing', title: '损坏链接' }) + '\n');
  await assert.rejects(SessionJournal.open(path), /链接非法/);
});

test('HTTP 回溯保留两条分支、拒绝旧实例请求，加载与预览不会执行模型或工具', async t => {
  const { call, post, initial, sessions, path, savesDir } = await server(t);
  const session = sessions.get(initial.sessionId)!;
  let requests = 0;
  const rounds: ToolIntent[][] = [
    [{ name: 'move_to', arguments: { target: { x: 5, y: 9 } } }, { name: 'finish_task', arguments: { reason: '原分支结束' } }],
    [{ name: 'move_to', arguments: { target: { x: 3, y: 8 } } }, { name: 'finish_task', arguments: { reason: '新分支结束' } }],
  ];
  session.adapter = { mode: 'live', label: '历史测试', model: demoModel, streamFn: () => toolStream(rounds[requests++] ?? []) };
  session.agent.streamFunction = session.adapter.streamFn;
  await post('command', initial, { text: '检查原路线' }); await session.settled();
  const original = session.view(), originalMessages = json(session.agent.state.messages);
  assert.equal(requests, 1); assert.equal(original.history.nodes.length, 2);
  const before = session.save();
  const preview = await call<HistoryPreview>(`${path}/history?node=${initial.history.headId}`);
  assert.equal(preview.status, 200); assert.equal(preview.data.state.elapsedTU, 0);
  assert.deepEqual(session.save(), before); assert.equal(requests, 1);
  const invalid = await post('rewind', original, { nodeId: crypto.randomUUID() }); assert.equal(invalid.status, 400);
  const directory = join(savesDir, initial.sessionId);
  const records = (await readFile(join(directory, 'session.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JournalEntry);
  const stateNode = records.find(entry => entry.type === 'state')!;
  assert.ok('id' in stateNode);
  assert.equal((await post('rewind', original, { nodeId: stateNode.id })).status, 400);
  const rewound = await post('rewind', original, { nodeId: initial.history.headId });
  assert.equal(rewound.status, 200); assert.equal(rewound.data.elapsedTU, 0); assert.equal(requests, 1);
  assert.equal(rewound.data.metrics.requests, original.metrics.requests);
  assert.equal((await post('marker', original, { position: { x: 3, y: 9 }, note: '旧请求', shared: true })).status, 409);
  assert.equal((await post('authorize', original, { authorizationId: crypto.randomUUID(), approve: true })).status, 409);
  await post('command', rewound.data, { text: '检查新路线' }); await session.settled();
  assert.equal(requests, 2);
  const branched = session.view();
  assert.equal(branched.history.nodes.length, 3);
  assert.deepEqual(branched.history.nodes.map(node => node.parentId), [null, initial.history.headId, initial.history.headId]);
  assert.ok(!JSON.stringify(session.agent.state.messages).includes('原分支结束'));
  const originalPreview = await call<HistoryPreview>(`${path}/history?node=${original.history.headId}`);
  assert.deepEqual(originalPreview.data.state.messages, original.messages);
  const selected = await post('rewind', branched, { nodeId: original.history.headId });
  assert.equal(selected.status, 200); assert.deepEqual(session.agent.state.messages, originalMessages);
  const loaded = await call(`${path}/load`, {});
  assert.equal(loaded.status, 200); assert.equal(loaded.data.history.headId, original.history.headId);
  assert.deepEqual(sessions.get(initial.sessionId)!.agent.state.messages, originalMessages);
  assert.equal(requests, 2);
  assert.equal((await call<HistoryView>(`${path}/history`)).data.nodes.length, 3);
});

test('运行期间没有逐格可继续节点，回溯请求被拒绝直到运行完全结束', async t => {
  const { post, initial, sessions } = await server(t);
  const session = sessions.get(initial.sessionId)!; session.delayMs = 40;
  await post('command', initial, { text: '前往 (5,9)' });
  assert.equal(session.running, true); assert.equal(session.view().history.nodes.length, 1);
  assert.equal((await post('rewind', session.view(), { nodeId: initial.history.headId })).status, 409);
  await session.settled();
  assert.equal(session.view().history.nodes.length, 2);
  assert.equal(session.engine.state.ledger.length, 3);
});

test('并发加载复用同一实例，并拒绝加载期间的新操作，避免历史出现两个写入者', async t => {
  const { call, post, initial, sessions, path, savesDir, server: http } = await server(t);
  const previous = sessions.get(initial.sessionId)!;
  let entered!: () => void, release!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const suspend = previous.suspend.bind(previous);
  previous.suspend = async () => { await suspend(); entered(); await gate; };
  const first = call(`${path}/load`, {});
  await loading;
  try {
    assert.equal((await post('command', initial, { text: '前往 (5,9)' })).status, 409);
    assert.equal((await post('marker', initial, { position: { x: 3, y: 9 }, note: '加载中', shared: true })).status, 409);
    const arriving = once(http, 'request');
    const second = call(`${path}/load`, {});
    await arriving;
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.data.sessionInstanceId, b.data.sessionInstanceId);
    const current = sessions.get(initial.sessionId)!;
    assert.notEqual(current, previous);
    assert.equal((await post('command', a.data, { text: '前往 (3,8)' })).status, 200);
    await current.settled();
    assert.deepEqual((await SessionJournal.open(join(savesDir, initial.sessionId))).restoreAt(), json(current.save()));
  } finally { release(); }
});
