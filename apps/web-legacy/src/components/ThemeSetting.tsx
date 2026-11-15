/**
 * 主题切换（设置 → 通用）。
 *
 * 选完立即生效并存到 localStorage，下次启动时在 main.tsx 里应用。
 */
import { useState } from 'react';

import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  applyTheme,
  parseTheme,
  type Theme,
} from './theme.js';

function readSaved(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return parseTheme(null);
  }
}

export function ThemeSetting(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(readSaved);

  const choose = (next: Theme): void => {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* 存不了不影响当前会话，只是下次启动恢复默认 */
    }
  };

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>主题</span>
        <span className="muted small">暗色是默认；亮色适合白天或明亮环境</span>
      </div>
      <div className="theme-row" role="radiogroup" aria-label="主题">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={theme === o.id}
            className={`btn btn--secondary btn--sm${theme === o.id ? ' active' : ''}`}
            onClick={() => choose(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
