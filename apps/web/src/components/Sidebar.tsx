/**
 * 侧边栏（工具面板）。
 *
 * 用户要求：「文件、浏览器等工具都要在侧边栏展示」。
 *
 * 所以这是一个**可切换的右侧面板**，不是又一个窗口：
 *   文件预览 / 浏览器（后续）都塞进同一个位置，按需打开。
 *
 * 设计约束：
 * - 打开时不挤压对话到不可读（主区最少留 480px）
 * - Esc 或点关闭按钮收起
 * - 内容区独立滚动，不动对话的滚动位置
 */
import { useEffect, useState } from 'react';
import { ApiClient } from '../api.js';

/** 侧边栏里能显示什么。 */
export type SidebarTab = 'file' | 'browser';

export interface SidebarProps {
  readonly tab: SidebarTab;
  /** file 标签下要预览的路径。 */
  readonly filePath?: string;
  /** browser 标签下的初始地址；不给就用 localhost:5173。 */
  readonly initialUrl?: string;
  readonly projectId: string;
  readonly onClose: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const api = useState(() => new ApiClient())[0];
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 浏览器地址栏。默认指向本地 dev server——那是最常看的东西。 */
  const [url, setUrl] = useState(props.initialUrl ?? 'http://localhost:5173');
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  /** 地址栏输入无效时的提示。 */
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    if (props.tab !== 'file' || !props.filePath) return;
    let alive = true;
    setContent(null);
    setError(null);
    void api
      .readFile(props.projectId, props.filePath)
      .then((r) => {
        if (alive) setContent(r.content);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => {
      alive = false;
    };
  }, [api, props.tab, props.filePath, props.projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const fileName = props.filePath?.replace(/\\/g, '/').split('/').pop() ?? '';
  const title = props.tab === 'browser' ? '浏览器' : fileName || '侧边栏';

  return (
    <aside className="sidebar" aria-label="侧边栏">
      <div className="sidebar-head">
        <span className="sidebar-title">{title}</span>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={props.onClose}
          aria-label="关闭侧边栏"
          title="关闭（Esc）"
        >
          ×
        </button>
      </div>

      {props.tab === 'browser' && (
        <form
          className="sidebar-url"
          onSubmit={(e) => {
            e.preventDefault();
            const next = normalizeUrl(url);
            // 地址不合法就**保持原样**，不要清掉已经打开的页面——
            // 用户输错一个字符就把正在看的东西弄没了，很烦。
            if (next) {
              setLoadedUrl(next);
              setUrlError(null);
            } else {
              setUrlError('只能打开 http / https 地址');
            }
          }}
        >
          <input
            className="sidebar-url-input"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError(null);
            }}
            placeholder="http://localhost:5173"
            spellCheck={false}
            aria-invalid={urlError !== null}
          />
          <button type="submit" className="btn btn--secondary btn--sm">
            打开
          </button>
        </form>
      )}

      {urlError && <p className="sidebar-url-error">{urlError}</p>}

      <div className={`sidebar-body${props.tab === 'browser' ? ' is-browser' : ''}`}>
        {props.tab === 'file' && (
          <>
            {error && <p className="sidebar-empty">读取失败：{error}</p>}
            {!error && content === null && <p className="sidebar-empty">正在读取…</p>}
            {content !== null && <pre className="sidebar-code">{content}</pre>}
          </>
        )}

        {props.tab === 'browser' && (
          <>
            {loadedUrl === null ? (
              <p className="sidebar-empty">
                输入地址后打开。本地 dev server（如 http://localhost:5173）最常用。
                <br />
                注意：有些网站禁止被嵌入（X-Frame-Options），会显示空白——那是对方的选择。
              </p>
            ) : (
              <iframe
                className="sidebar-frame"
                src={loadedUrl}
                title="浏览器预览"
                // 不给脚本同源权限：它是个预览，不是我们页面的一部分
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/** 补协议头；只放行 http/https，避免 javascript: 之类。 */
export function normalizeUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const withProto = /^[a-z]+:\/\//i.test(t) ? t : `http://${t}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
