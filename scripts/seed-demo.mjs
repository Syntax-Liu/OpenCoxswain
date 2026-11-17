/**
 * 为风格截图准备一份**有内容**的演示数据。
 *
 * ## 为什么需要
 *
 * 空状态下九套风格看起来几乎一样——差异全在圆角、行高、
 * 边框、密度这些"有内容才看得出"的地方。
 *
 * 所以：起一个临时项目目录，塞几个文件，再灌一段对话，
 * 让截图里真的有：消息、代码块、表格、侧栏树、右栏。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47911';
const DEMO = join(import.meta.dirname, '..', '.ui-demo-project');

/**
 * 服务端要求 Bearer token（`server.ts:186`）。
 * 它由 `TokenStore` 生成并落在 `~/.opencoxswain/token`。
 */
function readApiToken() {
  const paths = [
    join(process.env.HOME ?? '', '.opencoxswain', 'token'),
    join(process.env.USERPROFILE ?? '', '.opencoxswain', 'token'),
    join(homedir(), '.opencoxswain', 'token'),
    join(import.meta.dirname, '..', '.audit-home', '.opencoxswain', 'token'),
  ];
  for (const p of paths) {
    try {
      const t = readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('读不到 API token（~/.opencoxswain/token）');
}

const TOKEN = readApiToken();

/** 造一个像真项目的小目录，让侧栏和"文件"页有内容。 */
function makeDemoProject() {
  mkdirSync(join(DEMO, 'src', 'components'), { recursive: true });
  mkdirSync(join(DEMO, 'src', 'utils'), { recursive: true });

  writeFileSync(
    join(DEMO, 'package.json'),
    JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { test: 'vitest' } }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(DEMO, 'src', 'components', 'LoginForm.tsx'),
    `import { useState } from 'react';

/** 登录表单：用户名 + 密码 + 记住我 */
export function LoginForm({ onSubmit }: { onSubmit: (u: string, p: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(username, password); }}>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
      <button type="submit">登录</button>
    </form>
  );
}
`,
    'utf8',
  );
  writeFileSync(
    join(DEMO, 'src', 'utils', 'validate.ts'),
    `export function isValidEmail(v: string): boolean {
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v);
}
`,
    'utf8',
  );
  return DEMO;
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const rootPath = makeDemoProject();

const opened = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rootPath, name: 'demo-app' }),
});
console.log('项目已创建:', opened.project?.name ?? opened.project?.id);
console.log('rootPath:', rootPath);
console.log('\n下一步：在截图脚本里先 goto /，等侧栏出现项目，再切风格。');
