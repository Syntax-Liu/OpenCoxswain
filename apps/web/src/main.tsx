import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  parseFontScale,
} from './components/fontScale.js';
import { THEME_STORAGE_KEY, applyTheme, parseTheme } from './components/theme.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

// 字号在首帧就应用，避免先按默认尺寸画一遍再跳变。
try {
  applyFontScale(parseFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY)));
} catch {
  applyFontScale(DEFAULT_FONT_SCALE);
}

// 主题同样在首帧之前应用，避免先画一遍暗色再切成亮色。
try {
  applyTheme(parseTheme(localStorage.getItem(THEME_STORAGE_KEY)));
} catch {
  applyTheme(parseTheme(null));
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
