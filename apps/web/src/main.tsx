import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  parseFontScale,
} from './components/fontScale.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

// 字号在首帧就应用，避免先按默认尺寸画一遍再跳变。
try {
  applyFontScale(parseFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY)));
} catch {
  applyFontScale(DEFAULT_FONT_SCALE);
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
