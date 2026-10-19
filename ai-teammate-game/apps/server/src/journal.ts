import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext, AgentMessage } from '../../../../pi-main/packages/agent/dist/index.js';
import type { SessionSave } from './session.ts';
import type { Phase } from '../../../packages/game-core/src/types.ts';
import { modelErrorMessage } from './model.ts';

type Change = { path: string[]; value?: unknown; remove?: true };
type EntryData =
  | { type: 'model_request'; requestId: string; sequence: number; metadata: object; context: AgentContext }
  | { type: 'model_response'; requestId: string; message: AgentMessage }
  | { type: 'event'; requestId?: string; title: string; data: unknown }
  | { type: 'state'; changes: Change[] }
  | { type: 'boundary'; label: string; elapsedTU: number; phase: Phase };
type TreeEntry = EntryData & { id: string; parentId: string | null; timestamp: string };
type Header = { type: 'session'; version: 2; timestamp: string; initial: SessionSave };
export type JournalEntry = Header | TreeEntry | { type: 'head'; targetId: string; timestamp: string };
export interface HistoryNode { id: string; parentId: string | null; label: string; elapsedTU: number; phase: Phase }
export interface HistoryView { headId: string | null; nodes: HistoryNode[] }

// Arrays grow by index so appending an action never rewrites the preceding ledger.
function changesBetween(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (Object.is(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)
    && !(Array.isArray(before) && Array.isArray(after) && after.length < before.length)) {
    const previous = before as Record<string, unknown>, next = after as Record<string, unknown>;
    return [
      ...Object.keys(previous).filter(key => !Object.hasOwn(next, key)).map(key => ({ path: [...path, key], remove: true as const })),
      ...Object.keys(next).flatMap(key => Object.hasOwn(previous, key) ? changesBetween(previous[key], next[key], [...path, key]) : [{ path: [...path, key], value: next[key] }]),
    ];
  }
  return [{ path, value: after }];
}

function applyChanges(save: SessionSave, changes: Change[]): void {
  for (const change of changes) {
    if (!change.path.length || change.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('历史状态路径非法');
    let target = save as unknown as Record<string, unknown>;
    for (const key of change.path.slice(0, -1)) {
      if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object') throw new Error('历史状态路径不存在');
      target = target[key] as Record<string, unknown>;
    }
    const key = change.path[change.path.length - 1];
    if (change.remove) delete target[key]; else target[key] = structuredClone(change.value);
  }
}

/** One append-only tree is the authoritative save and the complete session log. */
export class SessionJournal {
  readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private requestId: string | null = null;
  private header: Header | null = null;
  private entries = new Map<string, TreeEntry>();
  private headId: string | null = null;
  private state: SessionSave | null = null;

  constructor(directory: string, initial?: SessionSave) {
    this.directory = directory;
    if (initial) this.capture(initial);
  }

  private write(entry: JournalEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    const pending = this.queue.then(async () => {
      if (this.writeError) throw this.writeError;
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, 'session.jsonl'), line, 'utf8');
    });
    this.queue = pending.catch(error => { this.writeError = error; console.error('对局历史写入失败：', error instanceof Error ? error.message : error); });
    return pending;
  }

  private append(data: EntryData): Promise<void> {
    const entry: TreeEntry = JSON.parse(JSON.stringify({ ...data, id: crypto.randomUUID(), parentId: this.headId, timestamp: new Date().toISOString() }));
    this.entries.set(entry.id, entry); this.headId = entry.id;
    return this.write(entry);
  }

  capture(save: SessionSave): void {
    if (this.writeError) throw this.writeError;
    const next: SessionSave = JSON.parse(JSON.stringify(save));
    if (!this.header) {
      this.header = { type: 'session', version: 2, timestamp: new Date().toISOString(), initial: next };
      void this.write(this.header).catch(() => undefined);
    } else {
      const changes = changesBetween(this.state, next);
      if (changes.length) void this.append({ type: 'state', changes }).catch(() => undefined);
    }
    this.state = next;
  }

  boundary(label: string): void {
    if (!this.state) throw new Error('对局历史尚未初始化');
    void this.append({ type: 'boundary', label, elapsedTU: this.state.engine.elapsedTU, phase: this.state.engine.phase }).catch(() => undefined);
  }

  private path(targetId: string | null): TreeEntry[] {
    const path: TreeEntry[] = [];
    let entry = targetId ? this.entries.get(targetId) : undefined;
    if (targetId && !entry) throw new Error('历史节点不存在');
    while (entry) { path.push(entry); entry = entry.parentId ? this.entries.get(entry.parentId) : undefined; }
    return path.reverse();
  }

  restoreAt(targetId = this.headId): SessionSave {
    if (!this.header) throw new Error('对局历史缺少初始状态');
    const save = structuredClone(this.header.initial);
    for (const entry of this.path(targetId)) if (entry.type === 'state') applyChanges(save, entry.changes);
    return save;
  }

  boundarySave(targetId: string): SessionSave {
    if (this.entries.get(targetId)?.type !== 'boundary') throw new Error('只能回溯到运行结束或手动操作完成的节点');
    return this.restoreAt(targetId);
  }

  async select(targetId: string): Promise<void> {
    const save = this.boundarySave(targetId);
    await this.flush();
    await this.write({ type: 'head', targetId, timestamp: new Date().toISOString() });
    this.headId = targetId; this.state = save; this.requestId = null;
  }

  history(): HistoryView {
    const nearest = new Map<string, string | null>();
    const nodes: HistoryNode[] = [];
    for (const entry of this.entries.values()) {
      const parentId = entry.parentId ? nearest.get(entry.parentId) ?? null : null;
      nearest.set(entry.id, entry.type === 'boundary' ? entry.id : parentId);
      if (entry.type === 'boundary') nodes.push({ id: entry.id, parentId, label: entry.label, elapsedTU: entry.elapsedTU, phase: entry.phase });
    }
    return { headId: this.headId ? nearest.get(this.headId) ?? null : null, nodes };
  }

  static async open(directory: string): Promise<SessionJournal> {
    const file = join(directory, 'session.jsonl');
    let contents = await readFile(file, 'utf8');
    let truncateTo: number | undefined;
    let addNewline = false;
    // Only a torn final write may be discarded; corrupt complete lines are errors.
    if (!contents.endsWith('\n')) {
      const end = contents.lastIndexOf('\n') + 1;
      try { JSON.parse(contents.slice(end)); contents += '\n'; addNewline = true; }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        contents = contents.slice(0, end); truncateTo = Buffer.byteLength(contents);
      }
    }
    const journal = new SessionJournal(directory);
    for (const line of contents.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as JournalEntry;
      if (!journal.header) {
        if (entry.type !== 'session' || entry.version !== 2 || entry.initial?.version !== 1) throw new Error('对局历史格式不兼容');
        journal.header = entry;
      } else if (entry.type === 'head') {
        if (journal.entries.get(entry.targetId)?.type !== 'boundary') throw new Error('当前历史节点非法');
        journal.headId = entry.targetId;
      } else {
        if (entry.type === 'session' || !entry.id || journal.entries.has(entry.id) || entry.parentId !== journal.headId) throw new Error('对局历史链接非法');
        if (!['state', 'boundary', 'event', 'model_request', 'model_response'].includes(entry.type)) throw new Error('未知历史记录类型');
        journal.entries.set(entry.id, entry); journal.headId = entry.id;
      }
    }
    journal.state = journal.restoreAt();
    if (truncateTo !== undefined) await truncate(file, truncateTo);
    else if (addNewline) await appendFile(file, '\n');
    return journal;
  }

  async beginRequest(sequence: number, metadata: object, context: AgentContext): Promise<void> {
    this.requestId = crypto.randomUUID();
    const loggedContext = { ...context, messages: context.messages.map(message => message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: modelErrorMessage(message.errorMessage) } : message) };
    await this.append({ type: 'model_request', requestId: this.requestId, sequence, metadata, context: loggedContext });
  }

  record(title: string, data: unknown, includeRequest = false): Promise<void> {
    return this.append({ type: 'event', ...(includeRequest && this.requestId ? { requestId: this.requestId } : {}), title, data });
  }

  response(message: AgentMessage): Promise<void> {
    if (!this.requestId) return Promise.resolve();
    const loggedMessage = message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: modelErrorMessage(message.errorMessage) } : message;
    return this.append({ type: 'model_response', requestId: this.requestId, message: loggedMessage });
  }

  endRun(): void { this.requestId = null; }
  async flush(): Promise<void> { await this.queue; if (this.writeError) throw this.writeError; }
}
