import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext, AgentMessage } from '../../../../pi-main/packages/agent/dist/index.js';
import type { SessionSave } from './session.ts';
import { modelErrorMessage } from './model.ts';

function fence(text: string, language = ''): string {
  const delimiter = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${delimiter}${language}\n${text}\n${delimiter}\n`;
}

function readableText(text: string): string {
  const marker = '当前机器人知识与任务（仅可见事实）：\n';
  const index = text.indexOf(marker);
  if (index >= 0) {
    try { return `${text.slice(0, index + marker.length)}\n${fence(JSON.stringify(JSON.parse(text.slice(index + marker.length)), null, 2), 'json')}`; } catch { /* Preserve non-JSON text verbatim. */ }
  }
  try { return fence(JSON.stringify(JSON.parse(text), null, 2), 'json'); } catch { return fence(text, 'text'); }
}

export function readableMessage(message: AgentMessage): string {
  const roles: Record<string, string> = { system: '系统提示', user: '玩家输入', assistant: '模型回复', toolResult: '工具结果' };
  let text = `### ${roles[message.role] ?? message.role}\n\n`;
  if (message.role === 'toolResult') text += `工具：${message.toolName}；调用 ID：${message.toolCallId}；错误：${message.isError ? '是' : '否'}\n\n`;
  if (typeof message.content === 'string') return text + readableText(message.content) + '\n';
  for (const block of message.content) {
    if (block.type === 'text') text += readableText(block.text);
    else if (block.type === 'toolCall') text += `工具调用：${block.name}；调用 ID：${block.id}\n\n${fence(JSON.stringify(block.arguments, null, 2), 'json')}`;
    else if (block.type === 'thinking') text += `服务商返回的思考内容：\n\n${readableText(block.thinking)}`;
    else text += fence(JSON.stringify(block, null, 2), 'json');
    text += '\n';
  }
  if (message.role === 'assistant') text += `结束原因：${message.stopReason}\n\n${fence(JSON.stringify({ usage: message.usage, errorMessage: message.errorMessage }, null, 2), 'json')}`;
  return text;
}

/** Ordered, unbounded disk logs; request inputs are flushed before model execution. */
export class SessionJournal {
  readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private requestPath: string | null = null;

  constructor(directory: string) { this.directory = directory; }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(error => { this.writeError = error; console.error('对局日志写入失败：', error instanceof Error ? error.message : error); });
    return pending;
  }

  async beginRequest(sequence: number, metadata: object, context: AgentContext): Promise<void> {
    const timestamp = new Date().toISOString();
    const name = `${String(sequence).padStart(6, '0')}-${timestamp.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
    this.requestPath = join(this.directory, 'models', `${name}.md`);
    const path = this.requestPath;
    // Serialize before any asynchronous write; omit executable functions, never record credentials.
    const loggedContext = { ...context, messages: context.messages.map(message => message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: modelErrorMessage(message.errorMessage) } : message) };
    const snapshot = JSON.stringify({ timestamp, sequence, metadata, context: loggedContext }, null, 2);
    const title = `# 模型调用 ${sequence}\n\n时间：${timestamp}\n\n${fence(JSON.stringify(metadata, null, 2), 'json')}`;
    const messages = loggedContext.messages.map(readableMessage).join('\n');
    const tools = (context.tools ?? []).map(tool => `### ${tool.name}\n\n${tool.description}\n\n${fence(JSON.stringify(tool.parameters, null, 2), 'json')}`).join('\n');
    await this.enqueue(async () => {
      await mkdir(join(this.directory, 'models'), { recursive: true });
      await writeFile(path, `${title}\n## 完整请求上下文\n\n${messages}\n## 可用工具及参数定义\n\n${tools}\n## 响应与执行日志\n\n请求已发起；后续响应和结果追加在下方。\n`, { encoding: 'utf8', flag: 'wx' });
      await writeFile(join(this.directory, 'models', `${name}.context.json`), snapshot + '\n', { encoding: 'utf8', flag: 'wx' });
      await appendFile(join(this.directory, 'events.md'), `\n## ${timestamp} · 模型调用 ${sequence}\n\n详情：[本次调用](models/${name}.md)\n`, 'utf8');
    });
  }

  record(title: string, data: unknown, includeRequest = false): Promise<void> {
    const entry = `\n## ${new Date().toISOString()} · ${title}\n\n${typeof data === 'string' ? readableText(data) : fence(JSON.stringify(data, null, 2), 'json')}\n`;
    const requestPath = includeRequest ? this.requestPath : null;
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, 'events.md'), entry, 'utf8');
      if (requestPath) await appendFile(requestPath, entry, 'utf8');
    });
  }

  response(message: AgentMessage): Promise<void> {
    const path = this.requestPath;
    const entry = `\n## ${new Date().toISOString()} · 模型响应\n\n${readableMessage(message)}\n`;
    return this.enqueue(async () => { if (path) await appendFile(path, entry, 'utf8'); });
  }

  endRun(): void { this.requestPath = null; }
  async flush(): Promise<void> { await this.queue; if (this.writeError) throw this.writeError; }
}

export function readableGame(save: SessionSave): string {
  const { engine } = save;
  const summary = { sessionId: save.id, levelId: engine.levelId, phase: engine.phase, elapsedTU: engine.elapsedTU, stateRevision: engine.stateRevision, human: engine.human, robot: engine.robot, task: save.task, metrics: save.metrics, modelConfig: save.modelConfig };
  const messages = save.messages.map(message => `### ${message.at} TU · ${message.role === 'human' ? '玩家' : message.role === 'robot' ? 'R-07' : '系统'}\n\n${message.tool ? fence(JSON.stringify(message.tool, null, 2), 'json') : ''}${message.text ? readableText(message.text) : ''}`).join('\n\n');
  const actions = engine.ledger.map(entry => `### 动作 ${entry.sequence} · ${entry.elapsedTU} TU\n\n${entry.message}\n\n${fence(JSON.stringify(entry, null, 2), 'json')}`).join('\n');
  return `# 对局 ${save.id}\n\n此文件随存档更新；完整历史见 events.md，每次模型调用见 models/。\n\n## 当前进度\n\n${fence(JSON.stringify(summary, null, 2), 'json')}\n## 最近对话\n\n${messages}\n\n## 完整行动账本\n\n${actions}\n`;
}
