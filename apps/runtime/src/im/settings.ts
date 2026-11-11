/**
 * IM 通道配置（Telegram）。
 *
 * 和模型设置分文件存放：两者的生命周期不同（换模型不换机器人），
 * 混在一起会让"清空模型密钥"顺手把 IM 绑定也清掉。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TelegramConfig } from './telegram.js';

export const EMPTY_IM_CONFIG: TelegramConfig = {
  botToken: '',
  chatIds: [],
  projectId: null,
};

export interface ImSettingsStoreOptions {
  readonly file: string;
}

export class ImSettingsStore {
  constructor(private readonly options: ImSettingsStoreOptions) {}

  get file(): string {
    return this.options.file;
  }

  /** 环境变量优先，方便自动化与临时调试。 */
  async resolve(): Promise<TelegramConfig> {
    const envToken = process.env.OPENCOXSWAIN_TELEGRAM_TOKEN?.trim();
    const saved = await this.read();

    if (envToken) {
      return {
        botToken: envToken,
        chatIds: saved.chatIds,
        projectId: saved.projectId,
      };
    }
    return saved;
  }

  async read(): Promise<TelegramConfig> {
    try {
      const raw = JSON.parse(await readFile(this.options.file, 'utf8')) as Partial<TelegramConfig>;
      return {
        botToken: typeof raw.botToken === 'string' ? raw.botToken.trim() : '',
        chatIds: Array.isArray(raw.chatIds)
          ? raw.chatIds.filter((id): id is string => typeof id === 'string')
          : [],
        projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,
      };
    } catch {
      return { ...EMPTY_IM_CONFIG };
    }
  }

  async save(config: TelegramConfig): Promise<void> {
    await mkdir(path.dirname(this.options.file), { recursive: true });
    await writeFile(
      this.options.file,
      `${JSON.stringify(
        {
          botToken: config.botToken.trim(),
          chatIds: [...config.chatIds],
          projectId: config.projectId,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  /** 清空配置（含 token）。 */
  async clear(): Promise<void> {
    await this.save({ ...EMPTY_IM_CONFIG });
  }
}
