/**
 * 联网工具：`read_url` 和 `web_search`。
 *
 * ## 为什么需要
 *
 * 现在 Agent 的工具全是本地操作。用户贴一个文档链接，
 * 模型只能靠 `run_command` 调 curl——在 Windows 上还要处理
 * 引号、编码、证书，经常翻车。
 *
 * ## 设计约束
 *
 * 1. **零依赖**：用 Node 内置 `fetch`（Node 18+）
 * 2. **体积上限**：网页动辄几百 KB，不截断会把上下文撑爆
 * 3. **转纯文本**：模型读 HTML 标签没有意义，去掉标签只留正文
 * 4. **超时**：网络请求必须能超时，否则一个卡住的站点会拖死整轮
 * 5. **只读**：这两个工具永远不改任何东西，不需要进副作用台账
 *
 * ## `web_search` 需要 key
 *
 * 搜索必须有服务商。这里支持在设置里配一个 endpoint + key；
 * 没配时**明确告诉模型"搜索不可用"**，而不是假装搜过。
 */

/** 单次抓取的最大字符数。 */
export const MAX_FETCH_CHARS = 60_000;
/** 默认超时。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface ReadUrlResult {
  readonly ok: boolean;
  readonly content: string;
  /** 是否被截断。 */
  readonly truncated?: boolean;
}

/** 把 HTML 转成可读纯文本。 */
export function htmlToText(html: string): string {
  let text = html;

  // 整段丢掉这些标签的内容（脚本、样式、注释）
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // 块级标签换成换行，保留段落结构
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '- ');

  // 剩下所有标签都去掉
  text = text.replace(/<[^>]+>/g, '');

  // 解码常见实体
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  // 压缩空白：连续空行压成一个，行尾空格去掉
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .trim();

  return text;
}

/** 抓一个 URL，转成纯文本。 */
export async function readUrl(
  url: string,
  options: { timeoutMs?: number; maxChars?: number } = {},
): Promise<ReadUrlResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxChars = options.maxChars ?? MAX_FETCH_CHARS;

  // 只允许 http(s)——`file://` 会让模型绕过项目的目录限制读任意文件
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, content: `不是合法的 URL：${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, content: `只支持 http/https，不支持 ${parsed.protocol}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 有些站点对无 UA 的请求直接 403
        'user-agent': 'OpenCoxswain/1.0 (+https://github.com/Syntax-Liu/OpenCoxswain)',
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      return { ok: false, content: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();

    // 二进制内容读成文本没有意义
    if (/^(image|audio|video|application\/octet-stream)/i.test(contentType)) {
      return { ok: false, content: `这个地址返回的是 ${contentType}，不是文本内容` };
    }

    let text = /html/i.test(contentType) || /^\s*</.test(raw) ? htmlToText(raw) : raw;

    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n\n…（内容过长已截断，原文 ${text.length} 字符）`;
      return { ok: true, content: text, truncated: true };
    }
    return { ok: true, content: text || '（页面没有可读文本）' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, content: `请求超时（${timeoutMs / 1000} 秒）` };
    }
    return {
      ok: false,
      content: `抓取失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 搜索结果的一条。 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
}

export interface SearchConfig {
  readonly endpoint: string;
  readonly apiKey: string;
}

export interface SearchResult {
  readonly ok: boolean;
  readonly content: string;
  readonly hits?: readonly SearchHit[];
}

/**
 * 联网搜索。
 *
 * 需要一个搜索服务（endpoint + key）。**没配时明确返回不可用**——
 * 不能让模型以为搜过了。
 *
 * 约定的接口（大多数搜索服务都能这么包装）：
 *
 *     POST <endpoint>
 *     Authorization: Bearer <key>
 *     { "query": "...", "count": 5 }
 *     → { "results": [{ "title", "url", "snippet" }] }
 */
export async function webSearch(
  query: string,
  config: SearchConfig | null,
  options: { timeoutMs?: number; count?: number } = {},
): Promise<SearchResult> {
  if (!config || !config.endpoint || !config.apiKey) {
    return {
      ok: false,
      content:
        '联网搜索未配置。你现在没有搜索能力。\n' +
        '如果需要查外部资料，请告诉用户「需要先在设置里配置搜索服务」，' +
        '或者让用户直接把内容贴给你。**不要假装搜索过。**',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ query, count: options.count ?? 5 }),
    });

    if (!response.ok) {
      return { ok: false, content: `搜索服务返回 HTTP ${response.status}` };
    }

    const data = (await response.json()) as { results?: unknown };
    const results = Array.isArray(data.results) ? data.results : [];

    const hits: SearchHit[] = [];
    for (const item of results) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const url = typeof r.url === 'string' ? r.url : '';
      if (!url) continue;
      hits.push({
        title: typeof r.title === 'string' ? r.title : url,
        url,
        ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
      });
    }

    if (hits.length === 0) return { ok: true, content: '没有搜到结果。', hits: [] };

    const text = hits
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n\n');

    return { ok: true, content: text, hits };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, content: '搜索请求超时' };
    }
    return {
      ok: false,
      content: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
