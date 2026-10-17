import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../apps/server/src/server.ts';
import { defaultModelConfig, validateModelConfig } from '../apps/server/src/model.ts';
import type { ModelPreferencesView } from '../apps/server/src/model-preferences.ts';
import type { SessionView } from '../apps/server/src/session.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';

const level = validateLevel(JSON.parse(await readFile(new URL('./fixtures/station-01.json', import.meta.url), 'utf8')));
const secret = 'fake-shared-model-key';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'last-oxygen-preferences-'));
  const savesDir = join(directory, 'saves'); const piDir = join(directory, 'pi');
  await mkdir(piDir);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  const active = new Set<ReturnType<typeof createAppServer>>();
  t.after(async () => {
    for (const app of active) await app.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const app = createAppServer(level, { savesDir, delayMs: 0 }); active.add(app);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    async function call<T = SessionView>(path: string, payload?: unknown) {
      const response = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const text = await response.text(); assert.ok(!text.includes(secret));
      return { status: response.status, data: JSON.parse(text) as T };
    }
    return { ...app, call, async close() { await app.shutdown(); active.delete(app); } };
  }
  return { savesDir, piDir, start };
}

async function endpoint(t: TestContext) {
  const requests: { path: string; authorization?: string }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the request before responding. */ }
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'chatcmpl-defaults', object: 'chat.completion.chunk', created: 1, model: 'mock-robot',
      choices: [{ index: 0, delta: { role: 'assistant', content: '已接入默认模型。' }, finish_reason: 'stop' }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const config = validateModelConfig({ ...defaultModelConfig, mode: 'live', provider: 'compatible', modelId: 'mock-robot', baseUrl: `http://127.0.0.1:${address.port}/v1` });
  return { config, requests };
}

test('应用模型将密钥保存到 pi 凭据，跨局和重启后自动复用，游戏存档不含密钥', async t => {
  const { savesDir, piDir, start } = await fixture(t); const { config, requests } = await endpoint(t);
  const app = await start(); const initial = (await app.call('/api/sessions', {})).data;
  const input = { requestId: crypto.randomUUID(), config: { ...config, apiKey: secret }, apiKey: secret };
  const applied = await app.call(`/api/sessions/${initial.sessionId}/model`, input);
  assert.equal(applied.status, 200);
  assert.deepEqual((await app.call(`/api/sessions/${initial.sessionId}/model`, input)).data, applied.data);
  const defaults = (await app.call<ModelPreferencesView>('/api/model-settings')).data;
  assert.deepEqual(defaults.config, config); assert.equal(defaults.credentialSource, 'pi');
  const auth = JSON.parse(await readFile(join(piDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth[`game-compatible:${config.baseUrl}`], { type: 'api_key', key: secret });
  const next = (await app.call('/api/sessions', {})).data;
  assert.equal(next.agentMode, 'live'); assert.equal(next.modelReady, true); assert.deepEqual(next.modelConfig, config);
  await app.call(`/api/sessions/${next.sessionId}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '检查状态' });
  await app.sessions.get(next.sessionId)!.settled();
  assert.equal(requests[0].authorization, `Bearer ${secret}`); assert.equal(app.sessions.get(next.sessionId)!.modelError, null);
  assert.ok(!(await readFile(join(savesDir, 'model-settings.json'), 'utf8')).includes(secret));
  const saves = (await app.call<{ id: string }[]>('/api/saves')).data; assert.equal(saves.length, 2);
  await app.close();
  for (const id of [initial.sessionId, next.sessionId]) assert.ok(!(await readFile(join(savesDir, id, 'game.json'), 'utf8')).includes(secret));
  const restarted = await start();
  const remembered = (await restarted.call('/api/sessions', {})).data;
  assert.deepEqual(remembered.modelConfig, config); assert.equal(remembered.modelReady, true); assert.equal(remembered.modelCredentialSource, 'pi');
  await restarted.call(`/api/sessions/${remembered.sessionId}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '检查状态' });
  await restarted.sessions.get(remembered.sessionId)!.settled();
  assert.equal(requests.length, 2); assert.equal(requests[1].authorization, `Bearer ${secret}`);
  const restored = (await restarted.call(`/api/sessions/${initial.sessionId}/load`, {})).data;
  assert.equal(restored.modelReady, true); assert.equal(restored.modelCredentialSource, 'pi');
});

test('更改默认保留其他对局配置，旧存档复用对应接口密钥，错误设置不覆盖默认', async t => {
  const { start } = await fixture(t); const { config, requests } = await endpoint(t);
  const app = await start(); const first = (await app.call('/api/sessions', {})).data;
  const path = `/api/sessions/${first.sessionId}`;
  await app.call(`${path}/model`, { requestId: crypto.randomUUID(), config, apiKey: secret });
  await app.call(`${path}/save`, { requestId: crypto.randomUUID() });
  const second = (await app.call('/api/sessions', {})).data;
  const secondPath = `/api/sessions/${second.sessionId}`;
  const other = { ...config, baseUrl: config.baseUrl.replace('/v1', '/other/v1'), maxTokens: 3000 };
  assert.equal((await app.call(`${secondPath}/model`, { requestId: crypto.randomUUID(), config: other, apiKey: '' })).status, 400);
  assert.deepEqual((await app.call<ModelPreferencesView>('/api/model-settings')).data.config, config);
  const otherSecret = 'fake-other-endpoint-key';
  assert.equal((await app.call(`${secondPath}/model`, { requestId: crypto.randomUUID(), config: other, apiKey: otherSecret })).status, 200);
  assert.deepEqual((await app.call(path)).data.modelConfig, config);
  const restored = (await app.call(`${path}/load`, {})).data;
  assert.deepEqual(restored.modelConfig, config); assert.equal(restored.modelReady, true);
  const next = (await app.call('/api/sessions', {})).data; assert.deepEqual(next.modelConfig, other);
  for (const session of [restored, next]) {
    await app.call(`/api/sessions/${session.sessionId}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '检查状态' });
    await app.sessions.get(session.sessionId)!.settled();
  }
  assert.deepEqual(requests.map(r => r.authorization), [`Bearer ${secret}`, `Bearer ${otherSecret}`]);
  assert.deepEqual(requests.map(r => r.path), ['/v1/chat/completions', '/other/v1/chat/completions']);
  await app.call(`${secondPath}/model`, { requestId: crypto.randomUUID(), config: { ...other, maxTokens: 99999 } });
  assert.deepEqual((await app.call<ModelPreferencesView>('/api/model-settings')).data.config, other);
  await app.close();
  const restarted = await start();
  for (const [sessionId, expected] of [[first.sessionId, config], [second.sessionId, other]] as const) {
    const restored = (await restarted.call(`/api/sessions/${sessionId}/load`, {})).data;
    assert.equal(restored.modelReady, true);
    await restarted.call(`/api/sessions/${sessionId}/command`, { requestId: crypto.randomUUID(), expectedRevision: restored.stateRevision, text: '检查状态' });
    await restarted.sessions.get(sessionId)!.settled();
    assert.deepEqual(restored.modelConfig, expected);
  }
  assert.deepEqual(requests.slice(2).map(r => r.authorization), [`Bearer ${secret}`, `Bearer ${otherSecret}`]);
  const unknown = { ...config, baseUrl: config.baseUrl.replace('/v1', '/unsaved/v1') };
  assert.equal((await restarted.call(`${path}/model`, { requestId: crypto.randomUUID(), config: unknown })).status, 400);
});

test('旧游戏环境配置不影响首次使用，自定义接口密钥需通过页面配置', async t => {
  const legacy = { GAME_AGENT_MODE: 'live', GAME_MODEL_PROVIDER: 'compatible', GAME_MODEL_ID: 'old-model', GAME_MODEL_BASE_URL: 'https://old.example/v1', GAME_MODEL_API_KEY: 'fake-old-env-key', GAME_MODEL_TIMEOUT_MS: 'invalid', GAME_MODEL_MAX_TOKENS: 'invalid' };
  const previous = new Map(Object.keys(legacy).map(name => [name, process.env[name]]));
  Object.assign(process.env, legacy);
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { start } = await fixture(t); const { config, requests } = await endpoint(t);
  const app = await start(); const initial = (await app.call('/api/sessions', {})).data;
  assert.equal(initial.agentMode, 'demo'); assert.deepEqual(initial.modelConfig, defaultModelConfig);
  const catalog = (await app.call<{ id: string; ready: boolean; credentialSource: string }[]>('/api/models')).data;
  const compatible = catalog.find(provider => provider.id === 'compatible')!;
  assert.equal(compatible.ready, false); assert.equal(compatible.credentialSource, 'none');
  const path = `/api/sessions/${initial.sessionId}`;
  assert.equal((await app.call(`${path}/model`, { requestId: crypto.randomUUID(), config })).status, 400);
  assert.deepEqual((await app.call<ModelPreferencesView>('/api/model-settings')).data.config, defaultModelConfig);
  assert.equal((await app.call(`${path}/model`, { requestId: crypto.randomUUID(), config, apiKey: secret })).status, 200);
  await app.call(`${path}/command`, { requestId: crypto.randomUUID(), expectedRevision: 0, text: '检查状态' });
  await app.sessions.get(initial.sessionId)!.settled();
  assert.equal(requests.length, 1); assert.equal(requests[0].authorization, `Bearer ${secret}`);
});

test('凭据保存失败明确报错，不覆盖原文件或新局默认，不回显密钥', async t => {
  const { start, piDir } = await fixture(t); const { config } = await endpoint(t);
  const app = await start(); const initial = (await app.call('/api/sessions', {})).data;
  const invalid = 'invalid-auth-file-fake-private-content';
  const path = join(piDir, 'auth.json'); await writeFile(path, invalid, 'utf8');
  const result = await app.call<{ error: string }>(`/api/sessions/${initial.sessionId}/model`, { requestId: crypto.randomUUID(), config, apiKey: secret });
  assert.equal(result.status, 400); assert.match(result.data.error, /无法保存本机 pi 凭据/);
  assert.ok(!result.data.error.includes(invalid)); assert.equal(await readFile(path, 'utf8'), invalid);
  assert.deepEqual((await app.call<ModelPreferencesView>('/api/model-settings')).data.config, defaultModelConfig);
});

test('页面填写的服务商密钥保存为 pi 标准凭据，留空及演示模式保留已有凭据', async t => {
  const { start, piDir } = await fixture(t);
  const oauth = { type: 'oauth', access: 'fake-other-access', refresh: 'fake-other-refresh', expires: Date.now() + 3600000 };
  await writeFile(join(piDir, 'auth.json'), JSON.stringify({ anthropic: oauth }), 'utf8');
  const config = { ...defaultModelConfig, mode: 'live' as const, timeoutMs: 15000 };
  const app = await start(); const initial = (await app.call('/api/sessions', {})).data;
  assert.equal((await app.call(`/api/sessions/${initial.sessionId}/model`, { requestId: crypto.randomUUID(), config, apiKey: secret })).status, 200);
  const savedAuth = JSON.parse(await readFile(join(piDir, 'auth.json'), 'utf8'));
  assert.deepEqual(savedAuth.deepseek, { type: 'api_key', key: secret }); assert.deepEqual(savedAuth.anthropic, oauth);
  await app.close();
  const restarted = await start(); const next = (await restarted.call('/api/sessions', {})).data;
  assert.equal(next.modelReady, true); assert.equal(next.modelCredentialSource, 'pi'); assert.deepEqual(next.modelConfig, config);
  assert.equal((await restarted.call(`/api/sessions/${next.sessionId}/model`, { requestId: crypto.randomUUID(), config, apiKey: '' })).status, 200);
  assert.equal((await restarted.call(`/api/sessions/${next.sessionId}/model`, { requestId: crypto.randomUUID(), config: { ...config, mode: 'demo' }, apiKey: 'fake-unused-demo-key' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(piDir, 'auth.json'), 'utf8')), savedAuth);
  await restarted.close();
  const demo = await start(); const final = (await demo.call('/api/sessions', {})).data;
  assert.equal(final.agentMode, 'demo'); assert.equal(final.modelConfig.timeoutMs, 15000);
});
