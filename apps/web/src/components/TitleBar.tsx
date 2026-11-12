import { useEffect, useState } from 'react';

import { readToken } from '../api.js';

/**
 * 自绘标题栏。
 *
 * 为什么需要：系统标题栏会在顶部留一条和界面割裂的框（用户反馈"最顶上有一条框"）。
 * DSH / VS Code 都是自绘标题栏，窗口是一个整体。
 *
 * 代价是窗口的最小化/最大化/关闭要自己做——
 * 这些操作走壳的 HTTP 接口（界面跑在 http 上拿不到 Tauri IPC）。
 */

/** 壳的窗口控制端口（与密钥服务同端口，共用一个令牌）。 */
const CONTROL_URL = 'http://127.0.0.1:47901';

type WindowAction = 'minimize' | 'toggle_maximize' | 'close';

/**
 * 窗口控制令牌。
 *
 * 由运行时注入到首屏（见 server.ts 的 injectToken 旁边的注入逻辑）。
 * 拿不到就当普通网页跑，按钮不显示。
 */
function controlToken(): string {
  const injected = (window as unknown as { __OCX_SECRET_TOKEN__?: unknown }).__OCX_SECRET_TOKEN__;
  return typeof injected === 'string' ? injected : '';
}

async function windowAction(action: WindowAction): Promise<void> {
  const token = controlToken();
  if (!token) return;
  try {
    await fetch(`${CONTROL_URL}/window/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // 窗口控制失败不影响使用：用户可以点任务栏。
  }
}

export interface TitleBarProps {
  /** 当前所在位置，例如"opencoxswain / 对话"。 */
  readonly crumb: string;
}

/** 判断是否在桌面壳里（没有控制令牌就是普通浏览器）。 */
export function isDesktopShell(): boolean {
  return controlToken() !== '';
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    setDesktop(isDesktopShell());
  }, []);

  // 拖拽区域：只有标题栏本身可拖，里面的按钮不行。
  return (
    <div className="title-bar" data-tauri-drag-region>
      <span className="title-bar-brand" data-tauri-drag-region>
        OpenCoxswain
      </span>
      <span className="title-bar-crumb" data-tauri-drag-region>
        {props.crumb}
      </span>

      {desktop && (
        <div className="title-bar-actions">
          <button
            type="button"
            className="win-btn"
            title="最小化"
            onClick={() => void windowAction('minimize')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn"
            title="最大化 / 还原"
            onClick={() => void windowAction('toggle_maximize')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="win-btn win-close"
            title="关闭（隐藏到托盘）"
            onClick={() => void windowAction('close')}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/** 供其他组件取：判断是否显示"桌面专属"的东西。 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(isDesktopShell()), []);
  void readToken;
  return desktop;
}
