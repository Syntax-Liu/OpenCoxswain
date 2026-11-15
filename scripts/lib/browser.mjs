/**
 * 真实浏览器驱动（CDP）。
 *
 * ## 为什么不用 jsdom / happy-dom
 *
 * 试过：受控组件（input / select / textarea）的交互在 happy-dom + React 18 下
 * 不可靠——受控值更新后，同步读到的 DOM 与组件状态会不一致，
 * 写出来的测试时过时不过，反而制造虚假信心。
 *
 * 真实 Chrome 没有这个问题。代价是必须起服务、有 Chrome，
 * 所以这类测试单独跑（`pnpm e2e`），不进单元测试。
 *
 * ## 用法
 *
 * ```js
 * const b = await openBrowser();
 * try {
 *   await b.goto('/');
 *   await b.click('button[aria-label="设置"]');
 *   assert.equal(await b.exists('.settings'), true);
 * } finally {
 *   await b.close();
 * }
 * ```
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chrome。E2E 测试需要真实浏览器；请安装 Chrome，或设置 OCX_CHROME 指向可执行文件。',
  );
}

let portSeq = 10400 + Math.floor(Math.random() * 400);

export async function openBrowser(options = {}) {
  const {
    baseUrl = process.env.OCX_URL ?? 'http://127.0.0.1:47910/',
    width = 1440,
    height = 900,
    outDir = process.env.OCX_OUT ?? './.ui-shots',
  } = options;

  const chromePath = process.env.OCX_CHROME ?? findChrome();
  const port = ++portSeq;
  const userDir = resolve(
    process.env.TEMP ?? '/tmp',
    `ocx-e2e-${process.pid}-${port}`,
  );

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 等 CDP 端口就绪
  let targets = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.length > 0) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  if (!targets || targets.length === 0) {
    chrome.kill();
    throw new Error('Chrome 没有在预期时间内启动');
  }

  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let msgId = 0;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      const onMsg = (e) => {
        const d = JSON.parse(e.data);
        if (d.id === id) {
          ws.removeEventListener('message', onMsg);
          d.error ? rej(new Error(d.error.message)) : res(d.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** 页面里的异常，便于断言"没有报错"。 */
  const pageErrors = [];
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.method === 'Runtime.exceptionThrown') {
      const desc = d.params.exceptionDetails.exception?.description;
      if (desc) pageErrors.push(desc);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });

  /** 在页面里执行表达式并取回值。 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result?.value;
  };

  const api = {
    chrome,
    pageErrors,
    evaluate,
    send,

    /** 打开页面并等待渲染。 */
    async goto(path = '/', waitMs = 2600) {
      const url = path.startsWith('http') ? path : `${baseUrl.replace(/\/$/, '')}${path}`;
      const sep = url.includes('?') ? '&' : '?';
      await send('Page.navigate', { url: `${url}${sep}_t=${Date.now()}` });
      await sleep(waitMs);
    },

    async exists(selector) {
      return evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    },

    async count(selector) {
      return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },

    async text(selector) {
      return evaluate(
        `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? null)`,
      );
    },

    async value(selector) {
      return evaluate(
        `(document.querySelector(${JSON.stringify(selector)})?.value ?? null)`,
      );
    },

    /** 按标签文字点按钮（比选择器稳）。 */
    async clickButton(label) {
      return evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
        if (!b) return 'not-found';
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      })()`);
    },

    async click(selector) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        el.click();
        return 'clicked';
      })()`);
    },

    /**
     * 在真实浏览器里填输入框。
     *
     * 用**原生 setter + input 事件**，React 的受控组件能正确收到——
     * 这是 happy-dom 里做不到的地方。
     */
    async fill(selector, text) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()`);
    },

    /** 选下拉框（真实 select 的 change 事件）。 */
    async select(selector, value) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'selected';
      })()`);
    },

    /** 按键盘（Escape 等）。 */
    async press(key, code = key, vk = 27, modifiers = 0) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers,
      });
      await sleep(300);
    },

    async waitFor(predicate, timeoutMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await predicate()) return true;
        await sleep(150);
      }
      return false;
    },

    async waitForSelector(selector, timeoutMs = 8000) {
      return api.waitFor(() => api.exists(selector), timeoutMs);
    },

    async screenshot(name, dir = outDir) {
      await mkdir(dir, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = resolve(dir, `${name}.png`);
      await writeFile(file, Buffer.from(r.data, 'base64'));
      return file;
    },

    async scrollTo(selector, top = 99999) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'not-found';
        el.scrollTop = ${top};
        return 'scrolled';
      })()`);
    },

    async close() {
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
      chrome.kill();
    },
  };

  return api;
}
