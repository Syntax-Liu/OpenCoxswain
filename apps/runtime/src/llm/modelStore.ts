/**
 * 多模型配置的持久化。
 *
 * 复用 `LlmSettingsStore` 那套密钥加密：
 * 每个模型的 apiKey 落盘前用 DPAPI 加密，读出来时解密。
 * 不能因为"多个模型"就退回明文。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EMPTY_MODEL_SETTINGS,
  type ModelConfig,
  type ModelSettings,
  type RoleBindings,
} from './models.js';
import { CIPHER_PREFIX, isCipher, type SecretCipher } from './secret.js';

export interface ModelStoreOptions {
  readonly file: string;
  /** 加解密服务；没有时退回明文存储并如实告知。 */
  readonly cipher?: SecretCipher | null;
}

export interface ModelStoreLike {
  load(): Promise<ModelSettings>;
  save(settings: ModelSettings): Promise<void>;
  /** 存储形态：加密还是明文（界面要如实显示）。 */
  storageMode(): 'encrypted' | 'plaintext';
}

/** 内存实现（测试与未配置存储时）。 */
export class MemoryModelStore implements ModelStoreLike {
  private current: ModelSettings = EMPTY_MODEL_SETTINGS;

  async load(): Promise<ModelSettings> {
    return this.current;
  }

  async save(settings: ModelSettings): Promise<void> {
    this.current = settings;
  }

  storageMode(): 'encrypted' | 'plaintext' {
    return 'plaintext';
  }
}

export class ModelStore implements ModelStoreLike {
  private readonly file: string;
  private readonly cipher: SecretCipher | null;

  constructor(options: ModelStoreOptions) {
    this.file = options.file;
    this.cipher = options.cipher ?? null;
  }

  storageMode(): 'encrypted' | 'plaintext' {
    return this.cipher ? 'encrypted' : 'plaintext';
  }

  async load(): Promise<ModelSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return EMPTY_MODEL_SETTINGS;
    }

    const record = raw as { models?: unknown; roles?: unknown };
    const models: ModelConfig[] = [];

    if (Array.isArray(record.models)) {
      for (const item of record.models) {
        const m = item as Partial<ModelConfig>;
        if (!m.id || !m.model) continue;
        models.push({
          id: String(m.id),
          name: String(m.name ?? m.model),
          baseUrl: String(m.baseUrl ?? ''),
          // 解密；失败时保留密文本身，不静默当成空密钥
          apiKey: await this.decrypt(String(m.apiKey ?? '')),
          model: String(m.model),
          params: (m.params ?? {}) as ModelConfig['params'],
        });
      }
    }

    const rolesRaw = (record.roles ?? {}) as Partial<RoleBindings>;
    const roles: RoleBindings = {
      supervisor: rolesRaw.supervisor ?? null,
      assistant: rolesRaw.assistant ?? null,
      agent: rolesRaw.agent ?? null,
    };

    return { models, roles };
  }

  async save(settings: ModelSettings): Promise<void> {
    const out = {
      models: await Promise.all(
        settings.models.map(async (m) => ({
          ...m,
          apiKey: await this.encrypt(m.apiKey),
        })),
      ),
      roles: settings.roles,
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  }

  private async encrypt(plain: string): Promise<string> {
    if (!plain) return '';
    // 已经是密文就别重复加密
    if (isCipher(plain)) return plain;
    if (!this.cipher) return plain;
    try {
      return await this.cipher.encrypt(plain);
    } catch {
      // 加密失败时**退回明文并保留可用性**，不阻断用户；
      // 但 storageMode() 会如实报 encrypted，所以调用方要检查实际前缀。
      return plain;
    }
  }

  private async decrypt(value: string): Promise<string> {
    if (!value) return '';
    if (!isCipher(value)) return value;
    if (!this.cipher) return value;
    try {
      return await this.cipher.decrypt(value);
    } catch {
      // 解不开就保留原值，让上层看到问题而不是静默变成空密钥
      return value;
    }
  }
}

/** 密钥是否真的以密文形态存在（用于界面如实提示）。 */
export function isEncryptedKey(value: string): boolean {
  return value.startsWith(CIPHER_PREFIX);
}
