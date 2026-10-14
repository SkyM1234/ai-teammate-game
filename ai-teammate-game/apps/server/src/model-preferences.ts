import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultModelConfig, liveModel, validateModelConfig } from './model.ts';
import type { ModelAdapter, ModelConfig } from './model.ts';
import type { CredentialSource } from './credentials.ts';

export interface ModelPreferencesView { config: ModelConfig; ready: boolean; credentialSource: CredentialSource }

export class ModelPreferences {
  private directory: string;
  private initialAdapter?: ModelAdapter;
  private config: ModelConfig;
  private saved = false;
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private keys = new Map<string, string>();

  constructor(directory: string, initialAdapter?: ModelAdapter) {
    this.directory = directory;
    this.initialAdapter = initialAdapter;
    this.config = { ...(initialAdapter?.config ?? defaultModelConfig) };
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(join(this.directory, 'model-settings.json'), 'utf8'));
        if (saved.version !== 1) throw new Error();
        this.config = validateModelConfig(saved.config); this.saved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取默认模型配置，请检查 model-settings.json。');
      }
    })();
    return this.loaded;
  }

  keyFor(config: ModelConfig): string | undefined {
    return this.keys.get(JSON.stringify([config.provider, config.baseUrl]));
  }

  async newSessionOptions(): Promise<{ adapter?: ModelAdapter; modelConfig: ModelConfig }> {
    await this.writes; await this.load();
    return { adapter: this.saved ? this.config.mode === 'live' ? await liveModel(this.config, this.keyFor(this.config)) : undefined : this.initialAdapter,
      modelConfig: { ...this.config } };
  }

  async view(): Promise<ModelPreferencesView> {
    await this.writes; await this.load();
    const adapter = this.config.mode === 'live' ? await liveModel(this.config, this.keyFor(this.config)) : undefined;
    return { config: { ...this.config }, ready: adapter?.ready !== false, credentialSource: adapter?.credentialSource ?? 'none' };
  }

  save(input: unknown, key: unknown, apply: (config: ModelConfig, apiKey?: string) => Promise<void>): Promise<void> {
    const config = validateModelConfig(input);
    if (key !== undefined && (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key))) throw new Error('API Key 格式不合法');
    const operation = this.writes.then(async () => {
      await this.load();
      const apiKey = typeof key === 'string' && key.trim() ? key.trim() : this.keyFor(config);
      await apply(config, apiKey);
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, 'model-settings.json');
      await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, config }, null, 2) + '\n', 'utf8');
      await rename(`${path}.tmp`, path);
      if (config.mode === 'live' && apiKey) this.keys.set(JSON.stringify([config.provider, config.baseUrl]), apiKey);
      this.config = config; this.saved = true;
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}
