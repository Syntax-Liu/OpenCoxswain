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
  readonly projectId: string;
  readonly onClose: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const api = useState(() => new ApiClient())[0];
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <aside className="sidebar" aria-label="侧边栏">
      <div className="sidebar-head">
        <span className="sidebar-title">{fileName || '侧边栏'}</span>
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

      <div className="sidebar-body">
        {props.tab === 'file' && (
          <>
            {error && <p className="sidebar-empty">读取失败：{error}</p>}
            {!error && content === null && <p className="sidebar-empty">正在读取…</p>}
            {content !== null && <pre className="sidebar-code">{content}</pre>}
          </>
        )}

        {props.tab === 'browser' && (
          <p className="sidebar-empty">浏览器预览还没做（预留位置）。</p>
        )}
      </div>
    </aside>
  );
}
