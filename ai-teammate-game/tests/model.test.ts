import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameSession } from '../apps/server/src/session.ts';
import { createAppServer } from '../apps/server/src/server.ts';
import { defaultModelConfig, liveModel, modelCatalog, validateModelConfig } from '../apps/server/src/model.ts';
import { validateLevel } from '../packages/game-core/src/level.ts';
import { SessionJournal } from '../apps/server/src/journal.ts';
import { deepseekProvider } from '../../pi-main/packages/ai/dist/providers/deepseek.js';

const level = validateLevel(JSON.parse(await readFile(new URL('../content/levels/station-01.json', import.meta.url), 'utf8')));
const secret = 'test-secret-never-save';
type Request = { path: string; authorization: string | undefined; body: Record<string, unknown> };
async function journal(t: TestContext, session: GameSession) {
  const directory = await mkdtemp(join(tmpdir(), 'last-oxygen-journal-'));
  session.journal = new SessionJournal(directory);
  t.after(async () => { await session.stop(); await session.journal!.flush(); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function endpoint(t: TestContext, reply: (res: ServerResponse, index: number) => void) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(raw) });
    reply(res, requests.length - 1);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const config = validateModelConfig({ ...defaultModelConfig, mode: 'live', provider: 'compatible', modelId: 'mock-robot', baseUrl: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 1000 });
  return { config, requests };
}
function completion(res: ServerResponse, calls: { name: string; arguments: unknown }[], text = '', reasoning = '') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'mock-robot', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant', content: text });
  if (reasoning) chunk({ reasoning_content: reasoning });
  calls.forEach((call, index) => chunk({ tool_calls: [{ index, id: `call_${index}_${crypto.randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
  chunk({}, calls.length ? 'tool_calls' : 'stop', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  res.end('data: [DONE]\n\n');
}

test('真实 pi 兼容接口发起 HTTP 请求，一轮工具串行执行并把结果送入下一请求', async t => {
  const { config, requests } = await endpoint(t, (res, index) => completion(res, index === 0 ? [
    { name: 'get_status', arguments: {} },
    { name: 'move_to', arguments: { target: { x: 3, y: 9 } } },
    { name: 'report', arguments: { text: '已移动一格。' } },
  ] : [{ name: 'finish_task', arguments: { reason: '检查结束。' } }], index === 0 ? '开始检查附近通道。' : ''));
  const session = new GameSession(level, { adapter: await liveModel(config, secret), delayMs: 0 });
  const directory = await journal(t, session);
  await session.command('检查附近通道并报告'); await session.settled();
  assert.equal(requests.length, 2); assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, `Bearer ${secret}`);
  assert.equal(requests[0].body.model, 'mock-robot'); assert.ok(Array.isArray(requests[0].body.tools));
  assert.equal(session.engine.state.elapsedTU, 1); assert.equal(session.metrics.executedTools, 4);
  assert.equal(session.metrics.inputTokens, 40); assert.equal(session.metrics.outputTokens, 20);
  assert.equal(session.task?.status, 'completed'); assert.equal(session.modelError, null);
  assert.ok(session.messages.some(m => m.text === '开始检查附近通道。'));
  const calls = session.view().messages.filter(message => message.kind === 'tool');
  assert.deepEqual(calls.map(message => message.tool?.name), ['get_status', 'move_to', 'report', 'finish_task']);
  assert.deepEqual(calls[1].tool?.arguments, { target: { x: 3, y: 9 } });
  assert.ok(calls.every(message => message.tool?.status === 'done'));
  assert.ok(session.messages.findIndex(message => message.text === '开始检查附近通道。') < session.messages.findIndex(message => message.kind === 'tool'));
  assert.deepEqual(session.save().messages.filter(message => message.kind === 'tool'), calls);
  const history = JSON.stringify(requests[1].body);
  assert.ok(history.includes('newDiscoveries')); assert.ok(history.includes('knownRefs')); assert.ok(history.includes('tool_call_id'));
  for (const request of requests) { const body = JSON.stringify(request.body); assert.ok(!body.includes('s-04')); assert.ok(!body.includes('a-01')); assert.ok(!body.includes(secret)); }
  assert.ok(JSON.stringify(requests[0].body.messages).includes('均使用简体中文'));
  assert.ok(!JSON.stringify(session.view()).includes(secret)); assert.ok(!JSON.stringify(session.save()).includes(secret));
  const files = (await readdir(join(directory, 'models'))).sort();
  const contexts = files.filter(name => name.endsWith('.context.json'));
  const logs = files.filter(name => name.endsWith('.md'));
  assert.equal(contexts.length, requests.length); assert.equal(logs.length, requests.length);
  const firstContext = JSON.parse(await readFile(join(directory, 'models', contexts[0]), 'utf8'));
  assert.equal(firstContext.metadata.model.id, 'mock-robot');
  assert.deepEqual(firstContext.context.tools.map((tool: { name: string }) => tool.name), session.agent.state.tools.map(tool => tool.name));
  const secondContext = await readFile(join(directory, 'models', contexts[1]), 'utf8');
  assert.ok(secondContext.includes('newDiscoveries')); assert.ok(secondContext.includes('toolCallId'));
  const firstLog = await readFile(join(directory, 'models', logs[0]), 'utf8');
  assert.ok(firstLog.includes('完整请求上下文')); assert.ok(firstLog.includes('系统提示')); assert.ok(firstLog.includes('开始检查附近通道。'));
  assert.ok(firstLog.includes('工具调用结果')); assert.ok(firstLog.includes('本轮决策结束'));
  const events = await readFile(join(directory, 'events.md'), 'utf8');
  assert.ok(events.includes('玩家对话')); assert.ok(events.includes('游戏动作')); assert.ok(events.includes('自动运行结束'));
  for (const name of files) assert.ok(!(await readFile(join(directory, 'models', name), 'utf8')).includes(secret));
});

test('DeepSeek 目录和兼容入口保留完整模型参数，pi-agent 正确发送 thinking 与推理工具历史', async t => {
  for (const modelId of ['deepseek-flash', 'deepseek-v4-pro']) {
    for (const provider of ['deepseek', 'compatible'] as const) {
      const { config: mock, requests } = await endpoint(t, (res, index) => completion(res, index === 0 ? [
        { name: 'get_status', arguments: {} },
        { name: 'move_to', arguments: { target: { x: 3, y: 9 } } },
      ] : [{ name: 'finish_task', arguments: { reason: '检查完成。' } }], '', 'mock-reasoning-for-tool-round'));
      const config = validateModelConfig({ ...defaultModelConfig, mode: 'live', provider, modelId, baseUrl: `https://api.deepseek.com${provider === 'compatible' ? '/v1' : ''}` });
      const adapter = await liveModel(config, secret);
      const catalog = deepseekProvider().getModels().find(m => m.id === modelId)!;
      assert.equal(adapter.model.reasoning, true);
      assert.deepEqual(adapter.model.compat, catalog.compat);
      assert.deepEqual(adapter.model.thinkingLevelMap, catalog.thinkingLevelMap);
      assert.equal(adapter.model.contextWindow, catalog.contextWindow);
      assert.equal(adapter.model.maxTokens, catalog.maxTokens);
      const localFetch: typeof fetch = (input, init) => {
        const original = new Request(input, init); const url = new URL(original.url);
        return fetch(new Request(new URL(url.pathname + url.search, mock.baseUrl), original));
      };
      const session = new GameSession(level, { adapter: { ...adapter, streamFn: (model, context, options) => adapter.streamFn(model, context, { ...options, fetch: localFetch }) }, delayMs: 0 });
      await session.command('检查附近通道'); await session.settled();
      assert.equal(session.modelError, null); assert.equal(session.task?.status, 'completed'); assert.equal(requests.length, 2);
      assert.equal(session.engine.state.elapsedTU, 1);
      for (const { body } of requests) {
        assert.equal(body.model, modelId); assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.max_tokens, 2000); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.store, undefined);
        const messages = body.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[] }[];
        assert.equal(messages[0].role, 'system'); assert.ok(!messages.some(m => m.role === 'developer'));
        for (const message of messages.filter(m => m.role === 'assistant')) assert.equal(message.reasoning_content, 'mock-reasoning-for-tool-round');
      }
      const history = requests[1].body.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[] }[];
      assert.equal(history.find(m => m.tool_calls)?.reasoning_content, 'mock-reasoning-for-tool-round');
      assert.ok(!JSON.stringify(session.view()).includes('mock-reasoning-for-tool-round'));
    }
  }
});

test('上游鉴权错误和超时暂停任务，不泄露上游错误内容或扣除资源', async t => {
  for (const failure of ['auth', 'timeout']) {
    const { config } = await endpoint(t, res => {
      if (failure === 'timeout') return;
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `invalid api key ${secret}`, type: 'authentication_error' } }));
    });
    const session = new GameSession(level, { adapter: await liveModel(config, secret), delayMs: 0 });
    const directory = await journal(t, session);
    await session.command('检查附近'); await session.settled();
    assert.equal(session.running, false); assert.equal(session.task?.status, 'paused');
    assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.engine.state.human.oxygen, 120);
    assert.ok(session.modelError); assert.ok(!JSON.stringify(session.view()).includes(secret));
    assert.match(session.modelError, failure === 'auth' ? /鉴权/ : /超时/);
    const logs = (await readdir(join(directory, 'models'))).filter(name => name.endsWith('.md'));
    assert.equal(logs.length, 1);
    const log = await readFile(join(directory, 'models', logs[0]), 'utf8');
    assert.ok(log.includes('模型响应')); assert.ok(log.includes('自动运行结束')); assert.ok(!log.includes(secret));
    if (failure === 'auth') {
      await session.continue(); await session.settled();
      const files = await readdir(join(directory, 'models'));
      assert.equal(files.filter(name => name.endsWith('.md')).length, 2);
      for (const name of files) assert.ok(!(await readFile(join(directory, 'models', name), 'utf8')).includes(secret));
    }
  }
});

test('执行一批动作后的下一次请求失败，仅保留已提交动作，恢复继续时不重放旧批次', async t => {
  const { config, requests } = await endpoint(t, (res, index) => {
    if (index === 0) completion(res, [{ name: 'move_to', arguments: { target: { x: 3, y: 9 } } }]);
    else if (index === 1) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'server failure' } })); }
    else completion(res, [{ name: 'finish_task', arguments: { reason: '检查结束。' } }]);
  });
  const session = new GameSession(level, { adapter: await liveModel(config, secret), delayMs: 0 });
  await session.command('检查附近通道'); await session.settled();
  assert.equal(session.task?.status, 'paused'); assert.equal(session.engine.state.elapsedTU, 1);
  assert.equal(session.engine.state.human.oxygen, 118); assert.equal(session.engine.state.ledger.length, 1);
  assert.ok(session.modelError); assert.equal(requests.length, 2);
  await session.continue(); await session.settled();
  assert.equal(session.task?.status, 'completed'); assert.equal(session.modelError, null);
  assert.equal(session.engine.state.elapsedTU, 1); assert.equal(session.engine.state.ledger.length, 1);
  assert.equal(requests.length, 3);
});

test('切换模型取消正在等待的网络请求，保留进度和委托；密钥不进入存档', async t => {
  let received!: () => void; const arrival = new Promise<void>(resolve => { received = resolve; });
  const { config } = await endpoint(t, () => received());
  const session = new GameSession(level, { delayMs: 0 });
  const directory = await journal(t, session);
  await session.configureModel(config, secret);
  await session.command('检查附近通道'); await arrival;
  await session.configureModel({ ...defaultModelConfig, mode: 'demo' }, undefined);
  await session.journal!.flush();
  assert.equal(session.running, false); assert.equal(session.adapter.mode, 'demo');
  assert.equal(session.task?.text, '检查附近通道'); assert.equal(session.task.status, 'paused');
  assert.equal(session.engine.state.elapsedTU, 0); assert.equal(session.agent.state.model.id, 'local-demo');
  const files = (await readdir(join(directory, 'models'))).filter(name => name.endsWith('.md'));
  assert.equal(files.length, 1);
  const cancelled = await readFile(join(directory, 'models', files[0]), 'utf8');
  assert.ok(cancelled.includes('取消当前运行')); assert.ok(cancelled.includes('自动运行结束')); assert.ok(!cancelled.includes(secret));
  await session.configureModel(config, secret);
  await session.configureModel({ ...config, timeoutMs: 2000 }, '');
  assert.equal(session.view().modelReady, true); assert.equal(session.view().modelConfig.timeoutMs, 2000);
  const save = session.save(); assert.ok(!JSON.stringify(save).includes(secret));
  const restored = new GameSession(level, { id: session.id, delayMs: 0 }); await restored.restore(save);
  assert.equal(restored.adapter.mode, 'live'); assert.equal(restored.view().modelReady, false);
  await restored.continue(); await restored.settled(); assert.equal(restored.running, false); assert.match(restored.modelError!, /API Key/);
});

test('配置 API、SSE 和落盘存档只包含非敏感模型设置', async t => {
  const { config } = await endpoint(t, res => completion(res, []));
  const savesDir = await mkdtemp(join(tmpdir(), 'last-oxygen-model-'));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(savesDir, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const app = createAppServer(level, { savesDir, delayMs: 0 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.shutdown(); await rm(savesDir, { recursive: true, force: true }); });
  async function post(path: string, data: unknown) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, text: await res.text() };
  }
  const created = await post('/api/sessions', {}); const id = JSON.parse(created.text).sessionId;
  const path = `/api/sessions/${id}`;
  const input = { requestId: crypto.randomUUID(), config, apiKey: secret };
  const applied = await post(`${path}/model`, input); assert.equal(applied.status, 200); assert.ok(!applied.text.includes(secret));
  assert.equal(JSON.parse(applied.text).agentMode, 'live');
  assert.equal((await post(`${path}/model`, input)).text, applied.text);
  const controller = new AbortController(); const response = await fetch(base + `${path}/events`, { signal: controller.signal });
  const reader = response.body!.getReader(); const chunk = await reader.read(); assert.ok(!new TextDecoder().decode(chunk.value).includes(secret));
  controller.abort(); await reader.cancel().catch(() => undefined);
  await post(`${path}/save`, { requestId: crypto.randomUUID() });
  const save = await readFile(join(savesDir, id, 'game.json'), 'utf8'); assert.ok(!save.includes(secret)); assert.ok(save.includes('mock-robot'));
  const catalog = await fetch(base + '/api/models').then(r => r.json()); assert.ok(catalog.some((p: { id: string }) => p.id === 'openai')); assert.ok(catalog.some((p: { id: string }) => p.id === 'google')); assert.ok(!JSON.stringify(catalog).includes(secret));
});

test('配置验证拒绝携带凭据的地址、未知目录模型和超预算参数', async () => {
  assert.throws(() => validateModelConfig({ ...defaultModelConfig, baseUrl: 'https://key:secret@api.deepseek.com' }), /凭据/);
  assert.throws(() => validateModelConfig({ ...defaultModelConfig, baseUrl: 'https://api.deepseek.com?key=secret' }), /查询/);
  assert.throws(() => validateModelConfig({ ...defaultModelConfig, modelId: 'unknown-model' }), /目录/);
  assert.throws(() => validateModelConfig({ ...defaultModelConfig, maxTokens: 99999 }), /上限/);
  assert.throws(() => validateModelConfig({ ...defaultModelConfig, timeoutMs: 0 }), /超时/);
  assert.ok((await modelCatalog())[0].models.includes(defaultModelConfig.modelId));
});
