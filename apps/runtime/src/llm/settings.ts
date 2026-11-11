/**
 * 模型密钥的本地保管。
 *
 * 优先级：环境变量 > 本地密钥文件。
 *
 * 为什么需要文件而不仅是环境变量：桌面应用双击启动时没有终端，
 * 用户不可能为了用它先去设置环境变量。所以界面要能填密钥并持久保存。
 *
 * 文件放在 `~/.opencoxswain/llm.json`，**只存本机**。
 * legacy 用 Windows DPAPI 加密过；这里先做明文 + 权限受限的目录，
 * 后续可无痛换成 DPAPI（接口不变）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LlmClient } from '../llm/types.js';
import { OpenAiCompatClient } from '../llm/types.js';

export interface LlmSettings {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';

export interface LlmSettingsStoreOptions {
  /** 密钥文件路径。 */
  readonly file: string;
}

export class LlmSettingsStore {
  constructor(private readonly options: LlmSettingsStoreOptions) {}

  get file(): string {
    return this.options.file;
  }

  /** 读配置：环境变量优先，其次本地文件。 */
  async resolve(): Promise<LlmSettings | null> {
    const apiKey = process.env.OPENCOXSWAIN_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    const baseUrl = process.env.OPENCOXSWAIN_LLM_BASE_URL ?? DEFAULT_BASE_URL;
    const model = process.env.OPENCOXSWAIN_LLM_MODEL ?? DEFAULT_MODEL;

    if (apiKey?.trim()) {
      return { apiKey: apiKey.trim(), baseUrl, model };
    }

    const saved = await this.read();
    if (saved?.apiKey) {
      return {
        apiKey: saved.apiKey,
        baseUrl: saved.baseUrl || baseUrl,
        model: saved.model || model,
      };
    }
    return null;
  }

  /** 只读文件，不回落环境变量。 */
  async read(): Promise<LlmSettings | null> {
    try {
      const raw = JSON.parse(await readFile(this.options.file, 'utf8')) as Partial<LlmSettings>;
      if (typeof raw.apiKey !== 'string' || !raw.apiKey.trim()) return null;
      return {
        apiKey: raw.apiKey.trim(),
        baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_BASE_URL,
        model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_MODEL,
      };
    } catch {
      return null;
    }
  }

  async save(settings: LlmSettings): Promise<void> {
    const apiKey = settings.apiKey.trim();
    if (!apiKey) throw new Error('模型密钥不能为空');
    await mkdir(path.dirname(this.options.file), { recursive: true });
    await writeFile(
      this.options.file,
      `${JSON.stringify(
        {
          apiKey,
          baseUrl: settings.baseUrl.trim() || DEFAULT_BASE_URL,
          model: settings.model.trim() || DEFAULT_MODEL,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  async clear(): Promise<void> {
    await rm(this.options.file, { force: true });
  }

  /**
   * 是否已配置（不暴露密钥本身）。
   *
   * 界面靠这个决定"显示配置引导"还是"显示对话区"。
   */
  async status(): Promise<{ configured: boolean; source: 'env' | 'file' | 'none'; baseUrl: string; model: string }> {
    const envKey = process.env.OPENCOXSWAIN_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    if (envKey?.trim()) {
      return {
        configured: true,
        source: 'env',
        baseUrl: process.env.OPENCOXSWAIN_LLM_BASE_URL ?? DEFAULT_BASE_URL,
        model: process.env.OPENCOXSWAIN_LLM_MODEL ?? DEFAULT_MODEL,
      };
    }
    const saved = await this.read();
    if (saved) {
      return { configured: true, source: 'file', baseUrl: saved.baseUrl, model: saved.model };
    }
    return { configured: false, source: 'none', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };
  }
}

/**
 * 可变 LLM 提供者：密钥在运行中保存后，**无需重启**即可生效。
 *
 * 为什么不用固定实例：用户在界面填完密钥应当立刻能用，
 * 而不是"请重启应用"。
 */
export class LlmProvider implements LlmClient {
  readonly name = 'deferred';
  private client: OpenAiCompatClient | null = null;

  constructor(private readonly store: LlmSettingsStore) {}

  /** 重新解析配置；返回是否已具备可用密钥。 */
  async refresh(): Promise<boolean> {
    const settings = await this.store.resolve();
    if (!settings) {
      this.client = null;
      return false;
    }
    this.client = new OpenAiCompatClient({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });
    return true;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  async chat(request: Parameters<OpenAiCompatClient['chat']>[0]) {
    if (!this.client) {
      // 没有密钥时给出可读原因，而不是抛一个空指针。
      throw new Error('尚未配置模型密钥：请在界面的设置里填写 API Key。');
    }
    return this.client.chat(request);
  }
}
