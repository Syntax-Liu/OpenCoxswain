import { useEffect, useState } from 'react';

import { copyText } from './MessageActions.js';

/**
 * 自定义右键菜单。
 *
 * 为什么需要：界面跑在 webview 里，默认右键弹出的是**浏览器菜单**
 * （"后退 / 刷新 / 检查"），一看就像网页而不是桌面软件。
 *
 * 这里接管右键，给桌面软件该有的操作：复制、全选。
 * 选中文字时才显示"复制"，否则只给"全选"。
 */

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly hasSelection: boolean;
  readonly selectionText: string;
}

export function ContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      // 输入框保留浏览器原生菜单：剪切/粘贴在那里更好用。
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

      event.preventDefault();

      const selection = window.getSelection();
      const text = selection?.toString() ?? '';
      setMenu({
        x: event.clientX,
        y: event.clientY,
        hasSelection: text.trim().length > 0,
        selectionText: text,
      });
    };

    const close = (): void => setMenu(null);

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);

    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  if (!menu) return null;

  // 靠近边缘时翻转，避免菜单被裁掉。
  const style: React.CSSProperties = {
    left: Math.min(menu.x, window.innerWidth - 180),
    top: Math.min(menu.y, window.innerHeight - 120),
  };

  return (
    <div className="ctx-menu" style={style} role="menu" onClick={(e) => e.stopPropagation()}>
      {menu.hasSelection && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            void copyText(menu.selectionText);
            setMenu(null);
          }}
        >
          复制
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          const selection = window.getSelection();
          const range = document.createRange();
          const root = document.querySelector('.messages') ?? document.body;
          range.selectNodeContents(root);
          selection?.removeAllRanges();
          selection?.addRange(range);
          setMenu(null);
        }}
      >
        全选
      </button>
      <div className="ctx-sep" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          // 重新加载界面：修复"界面卡住"时的应急手段。
          window.location.reload();
        }}
      >
        重新加载界面
      </button>
    </div>
  );
}
