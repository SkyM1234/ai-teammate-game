import { createAssistantMessageEventStream, createModels, createProvider } from '../../../../pi-main/packages/ai/dist/index.js';
import { builtinModels } from '../../../../pi-main/packages/ai/dist/providers/all.js';
import { openAICompletionsApi } from '../../../../pi-main/packages/ai/dist/api/openai-completions.lazy.js';
import type { Api, AssistantMessage, Model, JsonObject, Models } from '../../../../pi-main/packages/ai/dist/index.js';
import type { StreamFn } from '../../../../pi-main/packages/agent/dist/index.js';
import { modelCredentials } from './credentials.ts';
import type { CredentialSource } from './credentials.ts';

export interface ToolIntent { name: string; arguments: JsonObject }
export interface ModelConfig { mode: 'demo' | 'live'; provider: string; modelId: string; baseUrl: string; timeoutMs: number; maxTokens: number }
export interface ModelAdapter { mode: 'demo' | 'live' | 'test'; label: string; model: Model<Api>; streamFn: StreamFn; config?: ModelConfig; ready?: boolean; credentialSource?: CredentialSource; checkReady?: () => Promise<void> }
const catalog = builtinModels();
const deepseekDefault = catalog.getModel('deepseek', 'deepseek-chat')?.id ?? catalog.getModels('deepseek')[0].id;
export const defaultModelConfig: ModelConfig = { mode: 'demo', provider: 'deepseek', modelId: deepseekDefault, baseUrl: 'https://api.deepseek.com', timeoutMs: 30000, maxTokens: 2000 };

function providerCatalog() {
  return [...catalog.getProviders()].sort((a, b) => Number(b.id === 'deepseek') - Number(a.id === 'deepseek') || a.name.localeCompare(b.name)).flatMap(provider => {
    const models = catalog.getModels(provider.id);
    if (!models.length) return [];
    const baseUrl = provider.baseUrl ?? models[0].baseUrl;
    return [{ id: provider.id, name: provider.name, baseUrl: baseUrl ? new URL(baseUrl).href.replace(/\/$/, '') : '',
      defaultModel: provider.id === 'deepseek' ? deepseekDefault : provider.id === 'anthropic' && models.some(m => m.id === 'claude-sonnet-4-6') ? 'claude-sonnet-4-6' : models[0].id,
      models: models.map(m => m.id) }];
  });
}

async function authStatus(models: Models, providerId: string, manual = false): Promise<{ ready: boolean; credentialSource: CredentialSource }> {
  try {
    const auth = await models.checkAuth(providerId);
    return { ready: !!auth, credentialSource: !auth ? 'none' : manual ? 'manual' : auth.type === 'oauth' || auth.source === 'stored credential' ? 'pi' : 'environment' };
  } catch { return { ready: false, credentialSource: 'none' }; }
}

export async function modelCatalog() {
  const models = builtinModels({ credentials: modelCredentials() });
  const entries = await Promise.all(providerCatalog().map(async provider => ({ ...provider, ...await authStatus(models, provider.id) })));
  return [...entries, { id: 'compatible', name: '自定义兼容接口', baseUrl: '', defaultModel: '', models: [] as string[],
    ready: false, credentialSource: 'none' as const }];
}

export function validateModelConfig(input: unknown): ModelConfig {
  const value = input as ModelConfig;
  if (!value || !['demo', 'live'].includes(value.mode) || typeof value.provider !== 'string') throw new Error('模型模式或服务商不合法');
  const provider = value.provider === 'compatible' ? { baseUrl: '', models: [] as string[] } : providerCatalog().find(p => p.id === value.provider);
  if (!provider) throw new Error('模型模式或服务商不合法');
  const modelId = value.modelId;
  if (typeof modelId !== 'string' || !modelId || value.provider === 'compatible' && !/^[a-zA-Z0-9@][a-zA-Z0-9_./:@+-]{0,159}$/.test(modelId)) throw new Error('请输入有效的模型 ID');
  if (value.provider !== 'compatible' && !provider.models.includes(modelId)) throw new Error('模型 ID 不在当前 pi 目录中，请选择目录模型或自定义兼容接口');
  let baseUrl = value.baseUrl || provider.baseUrl;
  if (baseUrl || value.provider === 'compatible') {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的接口地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址只允许 HTTP(S)，不能包含凭据、查询参数或片段');
    baseUrl = url.href.replace(/\/$/, '');
  }
  if (value.provider !== 'compatible' && baseUrl !== provider.baseUrl.replace(/\/$/, '')) throw new Error('服务商接口地址固定；代理接口请使用自定义兼容接口');
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 120000) throw new Error('超时应为 1000–120000 毫秒');
  if (!Number.isInteger(value.maxTokens) || value.maxTokens < 256 || value.maxTokens > 8192) throw new Error('输出上限应为 256–8192 tokens');
  return { mode: value.mode, provider: value.provider, modelId, baseUrl, timeoutMs: value.timeoutMs, maxTokens: value.maxTokens };
}

export async function liveModel(config: ModelConfig, apiKey?: string): Promise<ModelAdapter> {
  const compatibleProvider = config.provider === 'compatible' && new URL(config.baseUrl).origin === 'https://api.deepseek.com' ? 'deepseek' : undefined;
  const providerId = config.provider === 'compatible' ? 'game-compatible' : config.provider;
  const credentials = modelCredentials(providerId, apiKey, compatibleProvider, config.provider === 'compatible' ? config.baseUrl : undefined);
  const models = config.provider === 'compatible' ? createModels({ credentials }) : builtinModels({ credentials });
  let model: Model<Api>;
  if (config.provider === 'compatible') {
    // A compatible endpoint must retain the real model's reasoning contract.
    // In particular, DeepSeek needs reasoning_content in assistant tool history.
    const deepseek = compatibleProvider ? catalog.getModel(compatibleProvider, config.modelId) : undefined;
    const custom: Model<'openai-completions'> = {
      ...(deepseek ?? demoModel), id: config.modelId, name: deepseek?.name ?? config.modelId, api: 'openai-completions', provider: 'game-compatible', baseUrl: config.baseUrl,
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...deepseek?.compat },
    };
    models.setProvider(createProvider({ id: 'game-compatible', name: '兼容接口', baseUrl: config.baseUrl, models: [custom], auth: { apiKey: {
      name: 'Game API key',
      async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key }, source: 'stored credential' } : undefined; },
    } }, api: openAICompletionsApi() }));
    model = custom;
  } else {
    const selected = models.getModel(config.provider, config.modelId);
    if (!selected) throw new Error('当前 pi 目录没有该模型');
    model = selected;
  }
  const adapter: ModelAdapter = { mode: 'live', label: `${config.provider} / ${config.modelId}`, config, model,
    async checkReady() { Object.assign(adapter, await authStatus(models, providerId, !!apiKey?.trim())); },
    streamFn: (selected, context, options) => models.streamSimple(selected, context, { ...options, timeoutMs: config.timeoutMs, maxRetries: 0, maxTokens: config.maxTokens }) };
  await adapter.checkReady!();
  return adapter;
}

// Only fixed messages leave the server; upstream errors can contain credentials or response bodies.
export function modelErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/EACCES|EPERM/.test(text)) return '模型网络访问被运行环境拒绝，请在允许联网的终端中启动服务。';
  if (/401|403|auth|api.?key|credential/i.test(text)) return '模型鉴权失败，请检查 API Key 和服务商权限。';
  if (/429|rate.?limit|quota|余额/i.test(text)) return '模型额度不足或请求过于频繁，请稍后重试。';
  if (/timeout|timed.?out|abort/i.test(text)) return '模型请求超时或被取消，请重新下达指令重试。';
  if (/fetch|network|connect|ENOTFOUND|ECONN/i.test(text)) return '无法连接模型服务，请检查接口地址与网络。';
  return '模型请求失败，请检查模型配置后重试。';
}

export const demoModel: Model<Api> = {
  id: 'local-demo', name: '本地规则演示', api: 'anthropic-messages', provider: 'local-demo', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048,
};

export function toolStream(calls: ToolIntent[]): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant', api: demoModel.api, provider: demoModel.provider, model: demoModel.id,
    content: calls.map(call => ({ type: 'toolCall', id: crypto.randomUUID(), name: call.name, arguments: call.arguments })),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  return stream;
}
