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
import { CIPHER_PREFIX, isCipher, type SecretCipher } from './secret.js';
import type { ModelParams } from './models.js';

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
  /**
   * 密钥加密（桌面壳提供 DPAPI）。
   *
   * 提供后 `apiKey` 以密文落盘；不提供时退回明文，
   * 由 `storageMode` 如实告知用户当前是什么状态。
   */
  readonly cipher?: SecretCipher | null;
}

export class LlmSettingsStore {
  constructor(private readonly options: LlmSettingsStoreOptions) {}

  get file(): string {
    return this.options.file;
  }

  /** 当前密钥是怎么存的：加密 / 明文 / 未配置（展示给用户）。 */
  get storageMode(): 'encrypted' | 'plaintext' {
    return this.options.cipher?.available ? 'encrypted' : 'plaintext';
  }

  /** 读配置：环境变量优先，其次本地文件。 */
  async resolve(): Promise<LlmSettings | null> {
    const apiKey = process.env.OPENCOXSWAIN_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    const baseUrl = process.env.OPENCOXSWAIN_LLM_BASE_URL ?? DEFAULT_BASE_URL;
    const model = process.env.OPENCOXSWAIN_LLM_MODEL ?? DEFAULT_MODEL;

    if (apiKey?.trim()) {
      // 即使这次用环境变量，也要读一次文件：`read()` 会把旧的明文密钥迁移成密文。
      // 早期只在走文件分支时才读，结果用环境变量的用户永远留着明文。
      void this.read().catch(() => {});
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

      const stored = raw.apiKey.trim();
      // 兼容旧版本留下的明文：**读得出来就继续可用**，
      // 用户不必因为升级而重新填密钥。
      const encrypted = isCipher(stored);
      const apiKey = encrypted ? await this.decryptOrFail(stored) : stored;
      if (!apiKey) return null;

      // 旧明文 + 现在有加密服务 → 顺手迁移成密文。
      // 不迁移的话，明文会一直躺在磁盘上，等于没做加密。
      if (!encrypted && this.options.cipher?.available) {
        try {
          await this.save({
            apiKey,
            baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_BASE_URL,
            model: typeof raw.model === 'string' ? raw.model : DEFAULT_MODEL,
          });
        } catch (error) {
          // 迁移失败不影响读取：本次照常可用，下次再试。
          // 但要留下痕迹，否则"以为加密了其实没有"最难查。
          console.warn(
            `密钥加密迁移失败（本次仍可用，按明文读取）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return {
        apiKey,
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

    // 有加密服务就以密文落盘；没有就如实存明文（不假装加密）。
    const stored = this.options.cipher?.available
      ? `${CIPHER_PREFIX}${await this.options.cipher.encrypt(apiKey)}`
      : apiKey;

    await mkdir(path.dirname(this.options.file), { recursive: true });
    await writeFile(
      this.options.file,
      `${JSON.stringify(
        {
          apiKey: stored,
          baseUrl: settings.baseUrl.trim() || DEFAULT_BASE_URL,
          model: settings.model.trim() || DEFAULT_MODEL,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  /** 解密失败当作"读不到"：宁可让用户重填，也不要抛异常卡住启动。 */
  private async decryptOrFail(stored: string): Promise<string | null> {
    const cipher = this.options.cipher;
    if (!cipher?.available) return null;
    try {
      return await cipher.decrypt(stored.slice(CIPHER_PREFIX.length));
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    await rm(this.options.file, { force: true });
  }

  /**
   * 是否已配置（不暴露密钥本身）。
   *
   * 界面靠这个决定"显示配置引导"还是"显示对话区"。
   */
  async status(): Promise<{
    configured: boolean;
    source: 'env' | 'file' | 'none';
    baseUrl: string;
    model: string;
    /** 密钥在磁盘上是怎么存的：加密还是明文。 */
    storage: 'encrypted' | 'plaintext';
  }> {
    const storage = this.storageMode;
    const envKey = process.env.OPENCOXSWAIN_LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    if (envKey?.trim()) {
      return {
        configured: true,
        source: 'env',
        storage,
        baseUrl: process.env.OPENCOXSWAIN_LLM_BASE_URL ?? DEFAULT_BASE_URL,
        model: process.env.OPENCOXSWAIN_LLM_MODEL ?? DEFAULT_MODEL,
      };
    }
    const saved = await this.read();
    if (saved) {
      return {
        configured: true,
        source: 'file',
        storage,
        baseUrl: saved.baseUrl,
        model: saved.model,
      };
    }
    return {
      configured: false,
      source: 'none',
      storage,
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
    };
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

  constructor(
    private readonly store: LlmSettingsStore,
    /**
     * 取当前生效的模型参数（来自多模型配置）。
     *
     * 为什么用回调而不是直接持有 ModelStore：`LlmProvider` 只关心
     * "这一轮该用哪些参数"，不关心模型怎么存、按角色怎么绑。
     * 把它和存储解耦，以后加角色级覆盖也不用动这里。
     */
    private readonly paramsOf?: () => Promise<ModelParams | null>,
  ) {}

  /** 重新解析配置；返回是否已具备可用密钥。 */
  async refresh(): Promise<boolean> {
    const settings = await this.store.resolve();
    if (!settings) {
      this.client = null;
      return false;
    }

    // 模型参数（是否支持图片等）。取不到就按不支持处理——**保守**。
    const params = (await this.paramsOf?.()) ?? null;

    this.client = new OpenAiCompatClient({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      // 只有明确声明支持的模型才发图片块。
      supportsImages: params?.supportsImages === true,
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
