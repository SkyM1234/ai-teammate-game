import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '../../../../pi-main/packages/coding-agent/dist/config.js';
import { resolveConfigValue } from '../../../../pi-main/packages/coding-agent/dist/core/resolve-config-value.js';
import type { ModelConfig } from './model.ts';

export type CredentialSource = 'manual' | 'pi' | 'environment' | 'none';

// Read only: never create, rewrite or copy pi's auth.json into the game directory.
export function readPiApiKey(provider: string, agentDir = getAgentDir()): string {
  let data: unknown;
  try { data = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error('无法读取本机 pi 凭据，请检查用户目录中的 auth.json。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('本机 pi auth.json 格式不合法。');
  const credential = (data as Record<string, unknown>)[provider] as { type?: string; key?: unknown; env?: unknown } | undefined;
  if (credential?.type !== 'api_key' || typeof credential.key !== 'string') return '';
  const env = credential.env;
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string'))) throw new Error('本机 pi 凭据环境配置格式不合法。');
  const key = resolveConfigValue(credential.key, env as Record<string, string> | undefined)?.trim() ?? '';
  if (/[\r\n]/.test(key)) throw new Error('本机 pi API Key 格式不合法。');
  return key;
}

export function modelCredential(config: Pick<ModelConfig, 'provider' | 'baseUrl'>, explicitKey?: string): { key: string; source: CredentialSource } {
  if (explicitKey?.trim()) return { key: explicitKey.trim(), source: 'manual' };
  let provider: string | undefined = config.provider === 'compatible' ? undefined : config.provider;
  // Never send the user's saved provider key to an unrelated custom endpoint.
  if (config.provider === 'compatible' && new URL(config.baseUrl).origin === 'https://api.deepseek.com') provider = 'deepseek';
  const localKey = provider ? readPiApiKey(provider) : '';
  if (localKey) return { key: localKey, source: 'pi' };
  const envName = config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : config.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GAME_MODEL_API_KEY';
  const key = process.env[envName]?.trim() ?? '';
  return { key, source: key ? 'environment' : 'none' };
}

export function hasPiApiKey(provider: string): boolean {
  try { return !!readPiApiKey(provider); } catch { return false; }
}
