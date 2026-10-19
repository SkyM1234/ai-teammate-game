import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { GameSession, interactionAction, RevisionConflictError } from './session.ts';
import type { SessionSave } from './session.ts';
import { modelCatalog } from './model.ts';
import type { ModelAdapter } from './model.ts';
import { validateLevel } from '../../../packages/game-core/src/level.ts';
import { SessionJournal } from './journal.ts';
import { ModelPreferences } from './model-preferences.ts';
import { loadLevels } from './levels.ts';
import type { Action, Level, Position } from '../../../packages/game-core/src/types.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
class HttpError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
function position(value: unknown, level: Level): Position {
  const p = value as Position;
  if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x >= level.width || p.y < 0 || p.y >= level.height) throw new HttpError(400, '坐标不合法');
  return { x: p.x, y: p.y };
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new HttpError(413, '请求过大'); chunks.push(chunk); }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { throw new HttpError(400, '请求必须是 JSON 对象'); }
}
function actionFrom(value: unknown, level: Level): Action {
  const input = value as Record<string, unknown>;
  if (!input || typeof input.kind !== 'string') throw new HttpError(400, '动作不合法');
  if (input.kind === 'move') return { kind: 'move', target: position(input.target, level) };
  if (input.kind === 'circuit' && typeof input.targetId === 'string' && typeof input.on === 'boolean') return { kind: 'circuit', targetId: input.targetId, on: input.on };
  if (input.kind === 'scan' && typeof input.targetId === 'string') return { kind: 'scan', targetId: input.targetId };
  const result = interactionAction({ operation: input.kind, targetId: typeof input.targetId === 'string' ? input.targetId : undefined, itemId: typeof input.itemId === 'string' ? input.itemId : undefined });
  if (!result) throw new HttpError(400, '动作参数不完整'); return result;
}

export function createAppServer(inputLevels: Level | Level[], options: { savesDir?: string; adapter?: ModelAdapter; delayMs?: number } = {}) {
  const levels = (Array.isArray(inputLevels) ? inputLevels : [inputLevels]).map(validateLevel);
  if (!levels.length || new Set(levels.map(level => level.id)).size !== levels.length) throw new Error('地图列表为空或 ID 重复');
  const levelsById = new Map(levels.map(level => [level.id, level]));
  const savesDir = options.savesDir ?? join(root, '.saves');
  const modelPreferences = new ModelPreferences(savesDir, options.adapter);
  const sessions = new Map<string, GameSession>();
  const pendingWrites = new Map<string, Promise<void>>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const requests = new Map<string, Promise<unknown>>();
  const eventClients = new Map<ServerResponse, GameSession>();
  let latestId: string | null = null;
  function persist(session: GameSession): Promise<void> {
    const save = session.save();
    const snapshot = JSON.stringify(save, null, 2) + '\n';
    const previous = pendingWrites.get(session.id) ?? Promise.resolve();
    const promise = previous.catch(() => undefined).then(async () => {
      await session.journal?.flush();
      const directory = join(savesDir, session.id);
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'game.json');
      const temporary = `${path}.tmp`;
      await writeFile(temporary, snapshot, 'utf8'); await rename(temporary, path);
    });
    pendingWrites.set(session.id, promise); return promise;
  }
  function register(session: GameSession) {
    session.journal = new SessionJournal(join(savesDir, session.id));
    void session.journal.record('创建或恢复对局', { sessionId: session.id, phase: session.engine.state.phase, elapsedTU: session.engine.state.elapsedTU, messages: session.messages }).catch(() => undefined);
    sessions.set(session.id, session); latestId = session.id;
    let savedRevision = session.engine.state.stateRevision;
    session.listeners.add(() => {
      clearTimeout(saveTimers.get(session.id));
      if (session.engine.state.stateRevision !== savedRevision) {
        savedRevision = session.engine.state.stateRevision;
        saveTimers.delete(session.id);
        void persist(session).catch(error => console.error('自动保存失败：', error.message));
        return;
      }
      saveTimers.set(session.id, setTimeout(() => { saveTimers.delete(session.id); void persist(session).catch(error => console.error('自动保存失败：', error.message)); }, 150));
    });
    return session;
  }
  async function listSaves() {
    await mkdir(savesDir, { recursive: true });
    const entries = await readdir(savesDir, { withFileTypes: true });
    const files = new Map<string, { id: string; modified: number }>();
    for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && uuidPattern.test(entry.name.slice(0, -5)))) {
      const id = entry.name.slice(0, -5); files.set(id, { id, modified: (await stat(join(savesDir, entry.name))).mtimeMs });
    }
    for (const entry of entries.filter(entry => entry.isDirectory() && uuidPattern.test(entry.name))) {
      try { files.set(entry.name, { id: entry.name, modified: (await stat(join(savesDir, entry.name, 'game.json'))).mtimeMs }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return [...files.values()].sort((a, b) => b.modified - a.modified);
  }
  async function load(id: string) {
    if (!uuidPattern.test(id)) throw new HttpError(400, '会话 ID 不合法');
    let save: SessionSave;
    try {
      await pendingWrites.get(id);
      let contents: string;
      try { contents = await readFile(join(savesDir, id, 'game.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; contents = await readFile(join(savesDir, `${id}.json`), 'utf8'); }
      save = JSON.parse(contents);
    }
    catch { throw new HttpError(404, '没有找到有效存档'); }
    const level = save.level ? validateLevel(save.level) : levelsById.get(save.engine.levelId);
    if (!level || level.id !== save.engine.levelId || level.version !== save.engine.levelVersion) throw new HttpError(400, '存档对应的地图版本不可用');
    const previous = sessions.get(id); if (previous) { await previous.stop(); await previous.journal?.flush(); }
    clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
    const session = new GameSession(level, { ...options, id });
    await session.restore(save); register(session);
    for (const [client, subscribed] of eventClients) if (subscribed === previous) client.end();
    await persist(session); return session;
  }
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new HttpError(403, '仅允许本地访问');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) throw new HttpError(403, '请求来源不匹配');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/main.js': ['main.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
        for (const track of ['bgm-exploration', 'rescue-success', 'mission-failure']) files[`/audio/${track}.wav`] = [`audio/${track}.wav`, 'audio/wav'];
        const file = files[url.pathname]; if (!file) throw new HttpError(404, '文件不存在');
        const data = await readFile(join(root, 'dist', file[0])); res.writeHead(200, { 'Content-Type': file[1].startsWith('audio/') ? file[1] : `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(data); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/latest') {
        let session = latestId ? sessions.get(latestId) : undefined;
        if (!session) { const saves = await listSaves(); if (saves[0]) session = await load(saves[0].id); }
        json(res, session?.view() ?? null); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/saves') { json(res, await listSaves()); return; }
      if (req.method === 'GET' && url.pathname === '/api/models') { json(res, await modelCatalog()); return; }
      if (req.method === 'GET' && url.pathname === '/api/levels') {
        json(res, levels.map(({ id, version, name, width, height }) => ({ id, version, name, width, height }))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/model-settings') { json(res, await modelPreferences.view()); return; }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const input = await body(req);
        const level = input.levelId === undefined ? levels[0] : typeof input.levelId === 'string' ? levelsById.get(input.levelId) : undefined;
        if (!level) throw new HttpError(400, '请选择有效地图');
        const session = register(new GameSession(level, { ...options, ...await modelPreferences.newSessionOptions() })); await persist(session); json(res, session.view(), 201); return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f\d-]+)(?:\/([\w-]+))?$/i);
      if (!match) throw new HttpError(404, '接口不存在');
      const [, id, operation] = match;
      if (req.method === 'POST' && operation === 'load') { await body(req); json(res, (await load(id)).view()); return; }
      const session = sessions.get(id); if (!session) throw new HttpError(404, '会话不存在');
      if (req.method === 'GET' && !operation) { json(res, session.view()); return; }
      if (req.method === 'GET' && operation === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (view: ReturnType<GameSession['view']>) => res.write(`id: ${view.sessionInstanceId}:${view.eventId}\ndata: ${JSON.stringify(view)}\n\n`);
        send(session.view()); session.listeners.add(send); eventClients.set(res, session);
        const heartbeat = setInterval(() => res.write(': alive\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); session.listeners.delete(send); eventClients.delete(res); }); return;
      }
      if (req.method === 'GET' && operation === 'replay') {
        const value = url.searchParams.get('step') ?? '0';
        if (!/^\d+$/.test(value)) throw new HttpError(400, '回溯步数必须是非负整数');
        const step = Number(value);
        if (!Number.isSafeInteger(step) || step > session.engine.state.ledger.length) throw new HttpError(400, '回溯步数超出行动账本范围');
        json(res, session.engine.replayAt(step)); return;
      }
      if (req.method !== 'POST') throw new HttpError(405, '请求方法不支持');
      const input = await body(req);
      if (typeof input.requestId !== 'string' || !uuidPattern.test(input.requestId)) throw new HttpError(400, '缺少有效请求 ID');
      const key = `${session.instanceId}:${input.requestId}`;
      let promise = requests.get(key);
      if (!promise) {
        promise = (async () => {
          if (!['stop', 'save', 'model', 'authorize', 'select-route'].includes(operation ?? '') && input.expectedRevision !== session.engine.state.stateRevision) throw new HttpError(409, '地图状态已更新，请根据最新信息重试');
          if (operation === 'command') {
            if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new HttpError(400, '指令长度应为 1–2000 字符');
            await session.command(input.text.trim(), input.selected ? position(input.selected, session.engine.level) : undefined, input.expectedRevision as number);
          } else if (operation === 'action') await session.manual(actionFrom(input.action, session.engine.level), input.requestId as string, input.allowHazard === true, input.expectedRevision as number);
          else if (operation === 'stop') await session.stop();
          else if (operation === 'model') await modelPreferences.save(input.config, input.apiKey, (config, apiKey) => session.configureModel(config, apiKey));
          else if (operation === 'authorize') {
            if (typeof input.authorizationId !== 'string' || !uuidPattern.test(input.authorizationId) || typeof input.approve !== 'boolean') throw new HttpError(400, '授权参数不合法');
            await session.authorize(input.authorizationId, input.approve);
          }
          else if (operation === 'select-route') {
            if (typeof input.selectionId !== 'string' || !uuidPattern.test(input.selectionId) || !['safe', 'shortest'].includes(input.choice as string)) throw new HttpError(400, '路线选择参数不合法');
            await session.selectRoute(input.selectionId, input.choice as 'safe' | 'shortest');
          }
          else if (operation === 'marker') {
            if (typeof input.note !== 'string' || typeof input.shared !== 'boolean') throw new HttpError(400, '标记参数不完整');
            session.marker(position(input.position, session.engine.level), input.note, input.shared);
          } else if (operation === 'remove-marker') {
            if (typeof input.markerId !== 'string' || !uuidPattern.test(input.markerId)) throw new HttpError(400, '缺少有效标记 ID');
            session.removeMarker(input.markerId);
          } else if (operation === 'save') await persist(session);
          else throw new HttpError(404, '操作不存在');
          return session.view();
        })();
        requests.set(key, promise);
        if (requests.size > 1000) requests.delete(requests.keys().next().value!);
      }
      json(res, await promise);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, { error: error instanceof Error ? error.message : '服务异常' }, error instanceof HttpError ? error.status : error instanceof RevisionConflictError ? 409 : 400);
    }
  });
  return { server, sessions, async shutdown() {
    for (const timer of saveTimers.values()) clearTimeout(timer); saveTimers.clear();
    for (const session of sessions.values()) { await session.stop(); await persist(session); }
    for (const timer of saveTimers.values()) clearTimeout(timer); saveTimers.clear();
    for (const client of eventClients.keys()) client.end();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const levels = await loadLevels(join(root, 'content/levels'));
  const app = createAppServer(levels);
  const port = Number(process.env.PORT ?? 4317);
  app.server.listen(port, '127.0.0.1', () => console.log(`LAST OXYGEN → http://127.0.0.1:${port}（请在页面“模型设置”中配置模型）`));
  process.on('SIGINT', () => { void app.shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void app.shutdown().then(() => process.exit(0)); });
}
