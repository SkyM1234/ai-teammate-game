import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentContext, AgentMessage } from '../../../../pi-main/packages/agent/dist/index.js';
import { modelErrorMessage } from './model.ts';

export type JournalEntry = { timestamp: string } & (
  | { type: 'model_request'; requestId: string; sequence: number; metadata: object; context: AgentContext }
  | { type: 'model_response'; requestId: string; message: AgentMessage }
  | { type: 'event'; requestId?: string; title: string; data: unknown }
);

/** Ordered, unbounded disk logs; request inputs are flushed before model execution. */
export class SessionJournal {
  readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private requestId: string | null = null;

  constructor(directory: string) { this.directory = directory; }

  private append(entry: JournalEntry): Promise<void> {
    // Capture mutable values before queuing; omit executable functions and credentials.
    const line = JSON.stringify(entry) + '\n';
    const pending = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, 'events.jsonl'), line, 'utf8');
    });
    this.queue = pending.catch(error => { this.writeError = error; console.error('对局日志写入失败：', error instanceof Error ? error.message : error); });
    return pending;
  }

  async beginRequest(sequence: number, metadata: object, context: AgentContext): Promise<void> {
    this.requestId = crypto.randomUUID();
    const loggedContext = { ...context, messages: context.messages.map(message => message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: modelErrorMessage(message.errorMessage) } : message) };
    await this.append({ type: 'model_request', timestamp: new Date().toISOString(), requestId: this.requestId, sequence, metadata, context: loggedContext });
  }

  record(title: string, data: unknown, includeRequest = false): Promise<void> {
    return this.append({ type: 'event', timestamp: new Date().toISOString(), ...(includeRequest && this.requestId ? { requestId: this.requestId } : {}), title, data });
  }

  response(message: AgentMessage): Promise<void> {
    if (!this.requestId) return Promise.resolve();
    const loggedMessage = message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: modelErrorMessage(message.errorMessage) } : message;
    return this.append({ type: 'model_response', timestamp: new Date().toISOString(), requestId: this.requestId, message: loggedMessage });
  }

  endRun(): void { this.requestId = null; }
  async flush(): Promise<void> { await this.queue; if (this.writeError) throw this.writeError; }
}
