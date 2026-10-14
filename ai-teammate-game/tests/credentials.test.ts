import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelCredential, readPiApiKey } from '../apps/server/src/credentials.ts';
import { defaultModelConfig, liveModel, modelCatalog } from '../apps/server/src/model.ts';
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
  const { dir, path } = await piUser(t);
  assert.equal(readPiApiKey('deepseek', dir), '');
  const contents = '\uFEFF' + JSON.stringify({ deepseek: { type: 'api_key', key: '${PI_TEST_API_KEY}', env: { PI_TEST_API_KEY: keyOne } }, anthropic: { type: 'oauth', access: 'not-an-api-key' } });
  await writeFile(path, contents, 'utf8');
  assert.equal(readPiApiKey('deepseek', dir), keyOne); assert.equal(readPiApiKey('anthropic', dir), '');
  assert.equal(modelCredential(config).source, 'pi'); assert.equal(modelCredential(config).key, keyOne);
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('pi 凭据优先于环境密钥，显式覆盖有效，任意自定义端点不会获得 pi 密钥', async t => {
  const { setKey } = await piUser(t); await setKey(keyOne);
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fake-env-key';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  assert.deepEqual(modelCredential(config), { key: keyOne, source: 'pi' });
  assert.deepEqual(modelCredential(config, keyTwo), { key: keyTwo, source: 'manual' });
  assert.equal(modelCredential({ provider: 'compatible', baseUrl: 'https://api.deepseek.com/v1' }).key, keyOne);
  for (const baseUrl of ['https://other.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com.other.example/v1']) assert.notEqual(modelCredential({ provider: 'compatible', baseUrl }).key, keyOne);
  await setKey(''); assert.deepEqual(modelCredential(config), { key: 'fake-env-key', source: 'environment' });
});

test('缺少或损坏凭据不会回显文件中的密钥或解析错误内容', async t => {
  const { dir, path } = await piUser(t);
  assert.equal(readPiApiKey('deepseek', dir), '');
  await writeFile(path, `invalid-json-${keyOne}`, 'utf8');
  assert.throws(() => readPiApiKey('deepseek', dir), error => error instanceof Error && /无法读取/.test(error.message) && !error.message.includes(keyOne));
  assert.equal(modelCatalog()[0].hasPiKey, false);
});

test('恢复和新会话自动使用 pi 密钥，每次模型请求重新读取；页面与存档不含密钥', async t => {
  const { path, setKey } = await piUser(t); await setKey(keyOne);
  const originalFile = await readFile(path, 'utf8');
  const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
  const adapter = liveModel(config);
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
  const save = session.save(); const restored = new GameSession(level, { id: session.id }); restored.restore(save);
  assert.equal(restored.view().modelReady, true); assert.equal(restored.view().modelCredentialSource, 'pi');
  const fresh = new GameSession(level, { adapter: liveModel(config) }); assert.equal(fresh.view().modelReady, true);
  await fresh.configureModel(config, ''); assert.equal(fresh.view().modelCredentialSource, 'pi');
  for (const key of [keyOne, keyTwo]) {
    assert.ok(!JSON.stringify(session.view()).includes(key)); assert.ok(!JSON.stringify(save).includes(key)); assert.ok(!JSON.stringify(modelCatalog()).includes(key));
  }
});
