import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerBuiltinUiPlugins } from './plugins/index.js';
import { UiRegistry } from './plugins/registry.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

const registry = new UiRegistry();
registerBuiltinUiPlugins(registry);

createRoot(root).render(
  <StrictMode>
    <App registry={registry} />
  </StrictMode>,
);
