/**
 * 联网搜索配置。
 *
 * ## 为什么需要存在本地
 *
 * `web_search` 需要一个搜索服务（endpoint + key）。
 * 没有配置时它必须**明确说不可用**——否则模型会编造搜索结果，
 * 那比没有搜索能力糟得多。
 *
 * ## key 怎么存
 *
 * 和模型密钥同样的处理：走运行时已有的密钥存储
 * （Windows 上是 DPAPI 加密）。这里只存"用哪个 endpoint"，
 * key 由调用方在读出后注入。
 *
 * 但为了简单和一致性，这一步先把 endpoint 和 key 都放在这个文件里，
 * 文件权限依赖 `~/.opencoxswain` 目录本身。**后续应改成走 DPAPI**。
 */
import path from 'node:path';

export interface SearchSettings {
  /** 空表示没配置。 */
  readonly endpoint: string;
  /** 空表示没配置。 */
  readonly apiKey: string;
}

export const DEFAULT_SEARCH: SearchSettings = { endpoint: '', apiKey: '' };

/** 是否已配置到"能用"的程度。 */
export function isSearchConfigured(s: SearchSettings): boolean {
  return s.endpoint.trim().length > 0 && s.apiKey.trim().length > 0;
}

export interface SearchStoreLike {
  load(): Promise<SearchSettings>;
  save(settings: SearchSettings): Promise<void>;
}

export class MemorySearchStore implements SearchStoreLike {
  private current: SearchSettings = DEFAULT_SEARCH;

  async load(): Promise<SearchSettings> {
    return this.current;
  }

  async save(settings: SearchSettings): Promise<void> {
    this.current = settings;
  }
}

export class SearchStore implements SearchStoreLike {
  constructor(private readonly file: string) {}

  async load(): Promise<SearchSettings> {
    try {
      const { readFile: rf } = await import('node:fs/promises');
      const raw = JSON.parse(await rf(this.file, 'utf8')) as {
        endpoint?: unknown;
        apiKey?: unknown;
      };
      return {
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      };
    } catch {
      return DEFAULT_SEARCH;
    }
  }

  async save(settings: SearchSettings): Promise<void> {
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    await mk(path.dirname(this.file), { recursive: true });
    await wf(
      this.file,
      `${JSON.stringify({ endpoint: settings.endpoint, apiKey: settings.apiKey }, null, 2)}\n`,
      'utf8',
    );
  }
}

/** 供测试和调用方复用的路径。 */
export function defaultSearchFile(home: string): string {
  return path.join(home, '.opencoxswain', 'search.json');
}
