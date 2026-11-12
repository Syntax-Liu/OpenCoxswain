/**
 * 访问令牌与 CORS 测试。
 *
 * 背景：原来 CORS 是 `*` 且完全无鉴权，**任意网页都能跨源读本地 API**，
 * 而 API 能派活、能跑命令。这组测试守住修复。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { isAllowedOrigin, isAuthorized, TokenStore } from '../server/token.js';
import { injectToken } from '../server/server.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmpTokenFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-token-'));
  temps.push(dir);
  return path.join(dir, 'token');
}

describe('令牌生成与持久化', () => {
  it('首次生成，之后复用同一个', async () => {
    const file = await tmpTokenFile();
    const store = new TokenStore({ file });

    const first = await store.resolve();
    const second = await store.resolve();

    assert.ok(first.length >= 32, `令牌太短：${first.length}`);
    assert.equal(first, second, '同一个令牌文件应返回同一个令牌');
  });

  it('令牌落盘', async () => {
    const file = await tmpTokenFile();
    const store = new TokenStore({ file });
    const token = await store.resolve();

    assert.equal((await readFile(file, 'utf8')).trim(), token);
  });

  it('两次全新安装得到不同令牌', async () => {
    const a = await new TokenStore({ file: await tmpTokenFile() }).resolve();
    const b = await new TokenStore({ file: await tmpTokenFile() }).resolve();
    assert.notEqual(a, b);
  });

  it('过短的文件内容视为无效（防止空文件被当成令牌）', async () => {
    const file = await tmpTokenFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'short', 'utf8');
    assert.equal(await new TokenStore({ file }).read(), null);
  });
});

describe('令牌校验', () => {
  const token = 'abc123def456ghi789jkl012mno345pqr';

  it('正确令牌通过', () => {
    assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  });

  it('大小写不敏感的 Bearer 前缀', () => {
    assert.equal(isAuthorized(`bearer ${token}`, token), true);
  });

  it('**缺失令牌拒绝**', () => {
    assert.equal(isAuthorized(undefined, token), false);
  });

  it('**错误令牌拒绝**', () => {
    assert.equal(isAuthorized('Bearer wrong-token', token), false);
  });

  it('长度不同直接拒绝（不泄露正确长度）', () => {
    assert.equal(isAuthorized('Bearer abc', token), false);
  });

  it('格式不对拒绝', () => {
    assert.equal(isAuthorized(token, token), false, '不能省略 Bearer 前缀');
  });
});

describe('CORS 来源白名单', () => {
  it('本地界面自己的来源放行', () => {
    assert.equal(isAllowedOrigin('http://127.0.0.1:47900', [47900]), true);
    assert.equal(isAllowedOrigin('http://localhost:47900', [47900]), true);
  });

  it('**外部网站一律拒绝**（这是修复的核心）', () => {
    assert.equal(isAllowedOrigin('https://evil.example.com', [47900]), false);
    assert.equal(isAllowedOrigin('http://evil.example.com:47900', [47900]), false);
  });

  it('本地但端口不同的也拒绝', () => {
    assert.equal(isAllowedOrigin('http://127.0.0.1:8080', [47900]), false);
  });

  it('非 http(s) 协议拒绝', () => {
    assert.equal(isAllowedOrigin('file:///tmp/x', [47900]), false);
  });

  it('没有 Origin（curl / 桌面壳）放行', () => {
    assert.equal(isAllowedOrigin(undefined, [47900]), true);
  });
});

describe('首屏令牌注入', () => {
  it('注入到 head 内', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectToken(html, 'tok123');
    assert.match(out, /window\.__OCX_TOKEN__="tok123"/);
    assert.ok(out.indexOf('__OCX_TOKEN__') < out.indexOf('<title>'), '应在 head 最前面');
  });

  it('没有 head 时放最前面', () => {
    const out = injectToken('<body>hi</body>', 'tok');
    assert.ok(out.startsWith('<script>'));
  });

  it('令牌里的特殊字符被正确转义', () => {
    const out = injectToken('<head></head>', 'a"b\\c');
    // 引号与反斜杠被 JSON 转义
    assert.ok(out.includes('"a\\"b\\\\c"'), `实际输出：${out}`);
  });

  it('**含 </script> 的令牌不能闭合脚本标签**（XSS 防护）', () => {
    const out = injectToken('<head></head>', '</script><img src=x onerror=alert(1)>');
    assert.ok(!out.includes('</script><img'), '不该出现可执行标签');
    assert.ok(out.includes('\\u003c'), '尖括号应被转义');
  });

  it('U+2028 / U+2029 被转义', () => {
    const out = injectToken('<head></head>', 'a\u2028b\u2029c');
    assert.ok(!out.includes('\u2028'));
    assert.ok(!out.includes('\u2029'));
  });
});
