/**
 * 字号调节。
 *
 * 四个档位，改的是根元素上的 `--font-scale`——
 * 整个界面等比缩放，不会出现"某处没变"。
 */
import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  parseFontScale,
  type FontScale,
} from './fontScale.js';

export function FontScaleSetting(): JSX.Element {
  const [scale, setScale] = useState<FontScale>(() => {
    try {
      return parseFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
    } catch {
      return DEFAULT_FONT_SCALE;
    }
  });

  // 首次挂载时应用一次（App 里也会应用，这里兜底保证设置页打开就生效）
  useEffect(() => {
    applyFontScale(scale);
  }, [scale]);

  const pick = useCallback((next: FontScale) => {
    setScale(next);
    applyFontScale(next);
    try {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
    } catch {
      /* 存不了就算了，本次会话仍然生效 */
    }
  }, []);

  return (
    <div className="field">
      <span className="field-label">界面字号</span>
      <div className="font-scale-row">
        {FONT_SCALE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`font-scale-btn${scale === option.id ? ' active' : ''}`}
            aria-pressed={scale === option.id}
            onClick={() => pick(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="muted small">
        整体缩放，所有控件一起变。当前比例 {Math.round(
          (FONT_SCALE_OPTIONS.find((o) => o.id === scale)?.factor ?? 1) * 100,
        )}
        %。
      </p>
    </div>
  );
}
