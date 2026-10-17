import { join } from 'node:path';
import { AuthStorage, ReadOnlyAuthStorage } from '../../../../pi-main/packages/coding-agent/dist/core/auth-storage.js';
import { RuntimeCredentials } from '../../../../pi-main/packages/coding-agent/dist/core/runtime-credentials.js';
import { getAgentDir } from '../../../../pi-main/packages/coding-agent/dist/config.js';
import { isCommandConfigValue, resolveConfigValue } from '../../../../pi-main/packages/coding-agent/dist/core/resolve-config-value.js';
import type { CredentialStore } from '../../../../pi-main/packages/ai/dist/index.js';
import type { ModelConfig } from './model.ts';

export type CredentialSource = 'manual' | 'pi' | 'environment' | 'none';

function credentialId(config: Pick<ModelConfig, 'provider' | 'baseUrl'>): string {
  return config.provider === 'compatible' ? `game-compatible:${config.baseUrl}` : config.provider;
}

export async function saveModelCredential(config: ModelConfig, apiKey: string): Promise<void> {
  try {
    const storage = AuthStorage.create(join(getAgentDir(), 'auth.json'));
    await storage.modify(credentialId(config), async current => ({ ...(current?.type === 'api_key' ? current : {}), type: 'api_key', key: apiKey }));
  } catch { throw new Error('无法保存本机 pi 凭据，请检查用户目录中的 auth.json 及写入权限。'); }
}

// Reuse pi's parser and value resolution. Catalog reads never create or rewrite
// auth.json; explicit key saves and OAuth refresh use pi's locked store.
export function modelCredentials(providerId?: string, apiKey?: string, compatibleProvider?: string, compatibleBaseUrl?: string): RuntimeCredentials {
  const authPath = join(getAgentDir(), 'auth.json');
  const store: CredentialStore = {
    async read(id, options) {
      if (id === 'game-compatible' && !compatibleBaseUrl && !compatibleProvider) return undefined;
      try {
        const storage = new ReadOnlyAuthStorage(authPath);
        const storedId = id === 'game-compatible' ? credentialId({ provider: 'compatible', baseUrl: compatibleBaseUrl ?? '' }) : id;
        let credential = await storage.read(storedId, options);
        if (!credential && id === 'game-compatible' && compatibleProvider) credential = await storage.read(compatibleProvider, options);
        if (id === 'game-compatible' && credential?.type !== 'api_key') return undefined;
        if (credential?.type !== 'api_key' || !credential.key) return credential;
        const key = isCommandConfigValue(credential.key) ? resolveConfigValue(credential.key, credential.env) : credential.key;
        if (key && /[\r\n]/.test(key)) throw new Error();
        return { ...credential, key: key?.trim() };
      } catch {
        options?.signal?.throwIfAborted();
        throw new Error('无法读取本机 pi 凭据，请检查用户目录中的 auth.json。');
      }
    },
    async list(options) {
      try { return await new ReadOnlyAuthStorage(authPath).list(options); }
      catch { options?.signal?.throwIfAborted(); throw new Error('无法读取本机 pi 凭据，请检查用户目录中的 auth.json。'); }
    },
    modify(id, fn, options) { return AuthStorage.create(authPath).modify(id, fn, options); },
    async delete() { throw new Error('请在 pi 中管理登录凭据。'); },
  };
  const credentials = new RuntimeCredentials(store);
  if (providerId && apiKey?.trim()) credentials.setRuntimeApiKey(providerId, apiKey.trim());
  return credentials;
}
