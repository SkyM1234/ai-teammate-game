import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCredentials, saveModelCredential } from '../apps/server/src/credentials.ts';
import { defaultModelConfig, demoModel, liveModel, modelCatalog, toolStream, validateModelConfig } from '../apps/server/src/model.ts';
import { builtinModels } from '../../pi-main/packages/ai/dist/providers/all.js';
import { createModels, createProvider } from '../../pi-main/packages/ai/dist/index.js';
import { GameSession } from '../apps/server/src/session.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';

async function piUser(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'last-oxygen-pi-auth-'));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original; await rm(dir, { recursive: true, force: true }); });
  const path = join(dir, 'auth.json');
  return { dir, path, async setKey(key: string) { await writeFile(path, JSON.stringify({ deepseek: { type: 'api_key', key } }), 'utf8'); } };
}
const config = { ...defaultModelConfig, mode: 'live' as const };
const keyOne = 'fake-pi-key-one'; const keyTwo = 'fake-pi-key-two';

test('只读复用 pi 用户凭据，支持 BOM 和 pi 的环境变量引用，不改写文件', async t => {
  const { path } = await piUser(t);
  const credentials = modelCredentials();
  assert.equal(await credentials.read('deepseek'), undefined);
  const contents = '\uFEFF' + JSON.stringify({ deepseek: { type: 'api_key', key: '${PI_TEST_API_KEY}', env: { PI_TEST_API_KEY: keyOne } }, anthropic: { type: 'oauth', access: 'not-an-api-key', refresh: 'fake-refresh', expires: Date.now() + 3600000 } });
  await writeFile(path, contents, 'utf8');
  assert.equal((await credentials.read('deepseek'))?.type, 'api_key');
  const models = builtinModels({ credentials });
  assert.equal((await models.getAuth('deepseek'))?.auth.apiKey, keyOne);
  assert.equal((await models.getAuth('anthropic'))?.auth.apiKey, 'not-an-api-key');
  assert.equal((await liveModel(config)).credentialSource, 'pi');
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('pi 凭据优先于环境密钥，显式覆盖有效，任意自定义端点不会获得 pi 密钥', async t => {
  const { setKey } = await piUser(t); await setKey(keyOne);
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fake-env-key';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  assert.equal((await liveModel(config)).credentialSource, 'pi');
  const overridden = builtinModels({ credentials: modelCredentials('deepseek', keyTwo) });
  assert.equal((await overridden.getAuth('deepseek'))?.auth.apiKey, keyTwo);
  assert.equal((await liveModel(config, keyTwo)).credentialSource, 'manual');
  assert.equal((await liveModel({ ...config, provider: 'compatible', baseUrl: 'https://api.deepseek.com/v1' })).credentialSource, 'pi');
  for (const baseUrl of ['https://other.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com.other.example/v1']) assert.notEqual((await liveModel({ ...config, provider: 'compatible', baseUrl })).credentialSource, 'pi');
  await setKey(''); assert.equal((await liveModel(config)).credentialSource, 'environment');
});

test('缺少或损坏凭据不会回显文件中的密钥或解析错误内容', async t => {
  const { path } = await piUser(t);
  assert.equal(await modelCredentials().read('deepseek'), undefined);
  await writeFile(path, `invalid-json-${keyOne}`, 'utf8');
  await assert.rejects(modelCredentials().read('deepseek'), error => error instanceof Error && /无法读取/.test(error.message) && !error.message.includes(keyOne));
  assert.equal((await modelCatalog())[0].ready, false);
  const before = await readFile(path, 'utf8');
  await assert.rejects(saveModelCredential(config, keyTwo), error => error instanceof Error && /无法保存/.test(error.message) && !error.message.includes(keyOne) && !error.message.includes(keyTwo));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('保存密钥自动创建 pi 用户目录，加锁合并并保留服务商原有配置', async t => {
  const { dir } = await piUser(t);
  const nested = join(dir, 'new-user', 'agent'); process.env.PI_CODING_AGENT_DIR = nested;
  const path = join(nested, 'auth.json');
  await Promise.all([saveModelCredential(config, keyOne), saveModelCredential({ ...config, provider: 'groq' }, keyTwo)]);
  const storage = modelCredentials();
  assert.equal((await storage.read('deepseek'))?.type, 'api_key');
  assert.equal((await storage.read('groq'))?.type, 'api_key');
  let auth = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(auth.deepseek.key, keyOne); assert.equal(auth.groq.key, keyTwo);
  auth.deepseek.env = { CUSTOM_PROVIDER_OPTION: 'preserved' };
  await writeFile(path, JSON.stringify(auth), 'utf8');
  await saveModelCredential(config, keyTwo);
  auth = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(auth.deepseek, { type: 'api_key', key: keyTwo, env: { CUSTOM_PROVIDER_OPTION: 'preserved' } });
  assert.equal(auth.groq.key, keyTwo);
});

test('恢复和新会话自动使用 pi 密钥，每次模型请求重新读取；页面与存档不含密钥', async t => {
  const { path, setKey } = await piUser(t); await setKey(keyOne);
  const originalFile = await readFile(path, 'utf8');
  const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
  const adapter = await liveModel(config);
  const seen: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request.headers.get('authorization')!);
    const chunk = { id: 'chatcmpl-auth-test', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, delta: { role: 'assistant', content: '等待你的下一步。' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const session = new GameSession(level, { adapter, delayMs: 0 });
  session.agent.streamFunction = (model, context, options) => adapter.streamFn(model, context, { ...options, fetch: mockFetch });
  assert.equal(session.view().modelReady, true); assert.equal(session.view().modelCredentialSource, 'pi');
  await session.command('检查状态'); await session.settled(); assert.equal(seen[0], `Bearer ${keyOne}`);
  assert.equal(await readFile(path, 'utf8'), originalFile);
  await setKey(keyTwo);
  await session.command('再次检查'); await session.settled(); assert.equal(seen[1], `Bearer ${keyTwo}`);
  const save = session.save(); const restored = new GameSession(level, { id: session.id }); await restored.restore(save);
  assert.equal(restored.view().modelReady, true); assert.equal(restored.view().modelCredentialSource, 'pi');
  const fresh = new GameSession(level, { adapter: await liveModel(config) }); assert.equal(fresh.view().modelReady, true);
  await fresh.configureModel(config, ''); assert.equal(fresh.view().modelCredentialSource, 'pi');
  for (const key of [keyOne, keyTwo]) {
    assert.ok(!JSON.stringify(session.view()).includes(key)); assert.ok(!JSON.stringify(save).includes(key)); assert.ok(!JSON.stringify(await modelCatalog()).includes(key));
  }
});

test('服务目录复用 pi-ai 的全部静态聊天模型，环境凭据无需游戏单独映射', async t => {
  const { path } = await piUser(t);
  const previous = process.env.GROQ_API_KEY; process.env.GROQ_API_KEY = keyOne;
  t.after(() => { if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous; });
  const entries = await modelCatalog();
  const builtin = builtinModels();
  for (const provider of builtin.getProviders().filter(p => builtin.getModels(p.id).length)) {
    const entry = entries.find(p => p.id === provider.id)!;
    assert.deepEqual(entry.models, builtin.getModels(provider.id).map(m => m.id));
    const selected = validateModelConfig({ ...defaultModelConfig, mode: 'live', provider: entry.id, modelId: entry.defaultModel, baseUrl: entry.baseUrl });
    const adapter = await liveModel(selected, keyTwo);
    assert.deepEqual(adapter.model, builtin.getModel(entry.id, entry.defaultModel));
  }
  assert.equal(entries.find(p => p.id === 'groq')?.credentialSource, 'environment');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('pi OAuth 凭据通过真实 Anthropic 流式适配器接入游戏，令牌不进入页面或存档', async t => {
  const { path } = await piUser(t);
  const access = 'sk-ant-oat01-fake-game-test'; const refresh = 'fake-game-refresh-token';
  const contents = JSON.stringify({ anthropic: { type: 'oauth', access, refresh, expires: Date.now() + 3600000 } });
  await writeFile(path, contents, 'utf8');
  const entry = (await modelCatalog()).find(p => p.id === 'anthropic')!;
  assert.equal(entry.ready, true); assert.equal(entry.credentialSource, 'pi');
  const adapter = await liveModel(validateModelConfig({ ...config, provider: entry.id, modelId: entry.defaultModel, baseUrl: entry.baseUrl }));
  let authorization = '';
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init); authorization = request.headers.get('authorization') ?? '';
    assert.equal(new URL(request.url).pathname, '/v1/messages');
    const events = [
      { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: entry.defaultModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '登录凭据已接入。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
  const session = new GameSession(level, { adapter, delayMs: 0 });
  session.agent.streamFunction = (model, context, options) => adapter.streamFn(model, context, { ...options, fetch: mockFetch });
  await session.command('检查状态'); await session.settled();
  assert.equal(authorization, `Bearer ${access}`); assert.equal(session.modelError, null);
  assert.ok(session.messages.some(m => m.text === '登录凭据已接入。'));
  assert.equal(await readFile(path, 'utf8'), contents);
  const serialized = JSON.stringify([session.view(), session.save(), await modelCatalog()]);
  assert.ok(!serialized.includes(access)); assert.ok(!serialized.includes(refresh));
  const override = await liveModel(adapter.config!, keyTwo); assert.equal(override.credentialSource, 'manual');
});

test('OAuth 过期复用 pi 的加锁刷新与持久化，并发请求只刷新一次，失败保留原凭据', async t => {
  const { path } = await piUser(t);
  const expired = { type: 'oauth' as const, access: keyOne, refresh: 'fake-old-refresh', expires: 0 };
  await writeFile(path, JSON.stringify({ anthropic: expired, deepseek: { type: 'api_key', key: keyOne } }), 'utf8');
  let refreshes = 0; let fail = false;
  const models = createModels({ credentials: modelCredentials() });
  models.setProvider(createProvider({ id: 'anthropic', name: 'Test OAuth', models: [{ ...demoModel, provider: 'anthropic' }],
    auth: { oauth: { name: 'Test login', async login() { return expired; },
      async refresh(current) { refreshes++; if (fail) throw new Error('refresh failed'); return { ...current, access: keyTwo, refresh: 'fake-new-refresh', expires: Date.now() + 3600000 }; },
      async toAuth(current) { return { apiKey: current.access }; } } },
    api: { stream: () => toolStream([]), streamSimple: () => toolStream([]) } }));
  const auth = await Promise.all([models.getAuth('anthropic'), models.getAuth('anthropic')]);
  assert.equal(refreshes, 1); assert.ok(auth.every(a => a?.auth.apiKey === keyTwo));
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.anthropic.access, keyTwo); assert.equal(saved.anthropic.refresh, 'fake-new-refresh'); assert.equal(saved.deepseek.key, keyOne);
  const original = JSON.stringify({ anthropic: expired }); await writeFile(path, original, 'utf8'); fail = true;
  await assert.rejects(models.getAuth('anthropic'), /OAuth refresh failed/);
  assert.equal(await readFile(path, 'utf8'), original);
});
