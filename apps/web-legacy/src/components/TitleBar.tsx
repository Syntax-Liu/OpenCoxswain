import { useEffect, useState } from 'react';

/**
 * 自绘标题栏。
 *
 * 为什么需要：系统标题栏会在顶部留一条和界面割裂的框。
 * DSH / VS Code 都是自绘标题栏，窗口是一个整体。
 *
 * ## 踩过的坑（这段代码是第三次修订）
 *
 * 1. 最初用 `data-tauri-drag-region`：Tauri 会在 mousedown 时
 *    preventDefault，**挡在里面的按钮永远收不到点击**。
 * 2. 用 `-webkit-app-region`：那是 Electron 的，Tauri 根本不认。
 * 3. 失败时只写 console.warn：用户看到的就是"点了没反应"，
 *    连排查都无从下手。
 *
 * 现在的做法：自己处理 mousedown 做拖拽，按钮完全独立，
 * **失败会显示出来**。
 */

/** 壳的窗口控制端口（与密钥服务同端口，共用一个令牌）。 */
const CONTROL_URL = 'http://127.0.0.1:47901';

type WindowAction = 'minimize' | 'toggle_maximize' | 'close' | 'start_drag';

/** 由运行时注入到首屏；普通浏览器里没有，前端据此判断"不是桌面环境"。 */
function controlToken(): string {
  const injected = (window as unknown as { __OCX_SECRET_TOKEN__?: unknown }).__OCX_SECRET_TOKEN__;
  return typeof injected === 'string' ? injected : '';
}

export interface TitleBarProps {
  /** 当前所在位置，例如"opencoxswain / 对话"。 */
  readonly crumb: string;
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  const [desktop, setDesktop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDesktop(controlToken() !== '');
  }, []);

  const act = async (name: WindowAction): Promise<void> => {
    const token = controlToken();
    if (!token) {
      setError('没有窗口控制令牌');
      return;
    }
    try {
      const res = await fetch(`${CONTROL_URL}/window/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        setError(null);
      } else {
        const text = await res.text().catch(() => '');
        setError(`${name}：HTTP ${res.status} ${text.slice(0, 60)}`);
      }
    } catch (e) {
      // 跨源被拒时会走到这里（TypeError: Failed to fetch）
      setError(`${name}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const startDrag = (): void => {
    void act('start_drag');
  };

  // 拖拽：标题栏按下鼠标就让壳移动窗口；落在按钮上则不动。
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input')) return;
    startDrag();
  };

  return (
    <>
      <div className="title-bar" onMouseDown={onMouseDown}>
        <span className="title-bar-brand">OpenCoxswain</span>
        {/* 面包屑与品牌同名时省略，避免标题栏出现两个「OpenCoxswain」。
            这是真机截图发现的：首屏 crumb 就是项目名，恰好等于产品名。 */}
        {props.crumb && props.crumb !== 'OpenCoxswain' && (
          <span className="title-bar-crumb">{props.crumb}</span>
        )}
        {desktop && (
          <div className="title-bar-actions">
            <button type="button" className="win-btn" title="最小化" onClick={() => void act('minimize')}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn"
              title="最大化 / 还原"
              onClick={() => void act('toggle_maximize')}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="win-btn win-close"
              title="关闭（隐藏到托盘）"
              onClick={() => void act('close')}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* 失败必须可见：否则用户只看到"点了没反应" */}
      {error && (
        <div className="title-bar-error" role="alert">
          窗口控制失败：{error}
        </div>
      )}
    </>
  );
}

/** 判断是否运行在桌面壳里。 */
export function isDesktopShell(): boolean {
  return controlToken() !== '';
}
