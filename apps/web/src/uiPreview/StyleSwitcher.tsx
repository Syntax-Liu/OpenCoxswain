/**
 * 九套风格方案的切换器（预览用）。
 *
 * ## 定位
 *
 * 这是一个**开发态对比工具**，不是产品功能。它只在 URL 带
 * `?ui=a` 之类的参数时才出现，正常使用完全看不到。
 *
 * ## 为什么放在 main.tsx 之外
 *
 * 它要操作 `<html data-style="...">`，和 App 的状态无关。
 * 挂在 App 里会让这个临时工具污染真正的产品代码。
 *
 * ## 为什么用 ui/ 的 Button
 *
 * `uiContract.test.ts` 有一条硬规则：`ui/` 之外不许出现裸 `<button>`。
 * 预览工具也不例外——**规则不因为"只是临时的"就有例外**，
 * 否则第一次例外之后，第二个、第三个就都来了。
 *
 * ## 九套方案
 *
 * | 代号 | 风格 | 一句话 |
 * | --- | --- | --- |
 * | A | VS Code 工作台 | 证据优先，装饰让位内容 |
 * | B | Linear 高密度 | 色调台阶叠层级，暗色优先 |
 * | C | macOS + Raycast | 圆角更大、间距更松、浮层更柔 |
 * | D | Windows 11 Fluent | 直角偏方，强调色克制 |
 * | E | Claude 温暖人文 | 暖底、行高最松，阅读优先 |
 * | F | Figma 画布 | 边框几乎消失，让内容说话 |
 * | G | Vercel 黑白 | 只有黑白灰 + 字重，亮色优先 |
 * | H | Cloudscape 状态驱动 | 密度最高，状态一眼可辨 |
 * | I | M3 Expressive | **仅对照**，大圆角 + 弹簧感 |
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Button, TextButton } from '../ui/index.js';

export interface StyleOption {
  readonly id: string;
  readonly name: string;
  readonly note: string;
}

/** 九套 + 「当前正式风格」。 */
export const STYLE_OPTIONS: readonly StyleOption[] = [
  { id: '', name: '0', note: '当前正式风格（无覆盖）' },
  { id: 'a', name: 'A', note: 'VS Code 工作台：证据优先' },
  { id: 'b', name: 'B', note: 'Linear 高密度：色调台阶' },
  { id: 'c', name: 'C', note: 'macOS + Raycast：柔角浮层' },
  { id: 'd', name: 'D', note: 'Windows 11 Fluent：平台补丁' },
  { id: 'e', name: 'E', note: 'Claude 温暖人文：阅读优先' },
  { id: 'f', name: 'F', note: 'Figma 画布：chrome 退隐' },
  { id: 'g', name: 'G', note: 'Vercel 黑白：亮色优先' },
  { id: 'h', name: 'H', note: 'Cloudscape：状态驱动' },
  { id: 'i', name: 'I', note: 'M3 Expressive：仅对照' },
];

const STORAGE_KEY = 'opencoxswain:ui-style';

/** 把风格应用到 `<html data-style>`。空串 = 移除属性。 */
export function applyStyle(styleId: string): void {
  const root = document.documentElement;
  if (styleId) root.setAttribute('data-style', styleId);
  else root.removeAttribute('data-style');
}

/** 从 URL 读出当前选择。 */
export function readStyleFromUrl(): string | null {
  try {
    const v = new URLSearchParams(window.location.search).get('ui');
    return v !== null && STYLE_OPTIONS.some((o) => o.id === v) ? v : null;
  } catch {
    return null;
  }
}

function Switcher(): JSX.Element {
  const [current, setCurrent] = useState<string>(() => readStyleFromUrl() ?? '');
  const [open, setOpen] = useState(true);

  useEffect(() => {
    applyStyle(current);
    try {
      if (current) localStorage.setItem(STORAGE_KEY, current);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 存不了不影响预览 */
    }
  }, [current]);

  // 键盘：1–9 切九套，0 回正式风格
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '9') {
        const id = String.fromCharCode(96 + Number(e.key));
        const opt = STYLE_OPTIONS.find((o) => o.id === id);
        if (opt) {
          setCurrent(opt.id);
          e.preventDefault();
        }
      } else if (e.key === '0') {
        setCurrent('');
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) {
    return (
      <div className="style-switcher-shell">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          风格预览
        </Button>
      </div>
    );
  }

  return (
    <div className="style-switcher-shell">
      <div className="style-switcher">
        <div className="style-switcher-head">
          <strong>九套风格预览</strong>
          <TextButton onClick={() => setOpen(false)}>收起</TextButton>
        </div>
        <p className="style-switcher-hint">按 1–9 切换，0 回到正式风格</p>
        {STYLE_OPTIONS.map((opt) => (
          <Button
            key={opt.id || 'default'}
            variant={opt.id === current ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setCurrent(opt.id)}
          >
            <span className="style-switcher-key">{opt.name}</span>
            {opt.note}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * 如果 URL 带了 `?ui=` 参数，挂载切换器。
 *
 * 不带参数时**什么都不做**——正常用户不会看到这个工具。
 */
export function mountStyleSwitcherIfRequested(): void {
  let requested = false;
  try {
    requested = new URLSearchParams(window.location.search).has('ui');
  } catch {
    requested = false;
  }
  if (!requested) return;

  const host = document.createElement('div');
  host.id = 'style-switcher-root';
  document.body.appendChild(host);
  createRoot(host).render(<Switcher />);
}
