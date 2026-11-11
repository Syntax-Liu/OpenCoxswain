/**
 * 静态资源服务测试（桌面壳直接加载界面用）。
 *
 * 重点在**路径穿越防护**：这个接口把磁盘上的文件暴露给 HTTP，
 * 一个 `../../` 就可能导致泄露任意文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { startServer, type RunningServer } from '../server/server.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
const servers: RunningServer[] = [];
after(async () => {
  for (const server of servers) await server.close().catch(() => {});
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** 造一个最小的工作台构建产物。 */
async function makeStaticDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-static-'));
  temps.push(dir);
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>SHELL</title>', 'utf8');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("hi")', 'utf8');
  await writeFile(path.join(dir, 'assets', 'app.css'), 'body{}', 'utf8');
  return dir;
}

async function boot(staticDir?: string): Promise<RunningServer> {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator({
    store,
    llm: new MockLlmClient(() => ({ text: 'ok' })),
  });
  const server = await startServer({
    orchestrator,
    store,
    port: 0,
    ...(staticDir ? { staticDir } : {}),
  });
  servers.push(server);
  return server;
}

describe('静态资源服务', () => {
  it('根路径返回 index.html', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /SHELL/);
  });

  it('按扩展名给出正确的 Content-Type', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const js = await fetch(`${server.url}/assets/app.js`);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    const css = await fetch(`${server.url}/assets/app.css`);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
  });

  it('未知路径回落到 index.html（单页应用路由）', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const res = await fetch(`${server.url}/some/deep/route`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SHELL/);
  });

  it('/api 前缀永远不走静态回落（不会把 API 404 变成 HTML）', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const res = await fetch(`${server.url}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('拒绝路径穿越（../ 不能读到 staticDir 之外的文件）', async () => {
    const dir = await makeStaticDir();
    // 在 staticDir 的父目录放一个"机密"文件
    const secret = path.join(path.dirname(dir), 'secret-outside.txt');
    await writeFile(secret, 'TOP-SECRET', 'utf8');
    temps.push(secret);

    const server = await boot(dir);
    const res = await fetch(`${server.url}/../secret-outside.txt`);

    // 可能是 403（被拦下），也可能被客户端规范化成 200+index.html；
    // 关键断言：**绝不能返回机密内容**。
    const text = await res.text();
    assert.doesNotMatch(text, /TOP-SECRET/, '不能泄露 staticDir 之外的文件');

    await rm(secret, { force: true });
  });

  it('编码后的路径穿越同样被拒', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const res = await fetch(`${server.url}/%2e%2e/%2e%2e/package.json`);
    const text = await res.text();
    assert.doesNotMatch(text, /"name":\s*"@opencoxswain\/runtime"/, '不能被编码绕过');
  });

  it('未配置 staticDir 时不提供静态文件（API 服务仍然正常）', async () => {
    const server = await boot();
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 404);

    const health = await fetch(`${server.url}/api/health`);
    assert.equal(health.status, 200);
  });
});

describe('静态资源缓存策略', () => {
  it('资产文件不能长缓存（回归：曾设 immutable，升级后界面还是旧的）', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const res = await fetch(`${server.url}/assets/app.js`);
    const cacheControl = res.headers.get('cache-control') ?? '';
    assert.match(cacheControl, /no-cache/);
    assert.doesNotMatch(cacheControl, /immutable/, '本地应用不能给静态资源设强缓存');
    assert.ok(res.headers.get('etag'), '必须带 ETag 以便协商缓存');
  });

  it('带相同 ETag 请求返回 304，不重复传输内容', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const first = await fetch(`${server.url}/assets/app.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.text();

    const second = await fetch(`${server.url}/assets/app.js`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal((await second.text()).length, 0);
  });

  it('文件内容变了，ETag 也变（保证能拿到新版）', async () => {
    const dir = await makeStaticDir();
    const server = await boot(dir);

    const first = await fetch(`${server.url}/assets/app.js`);
    const etagBefore = first.headers.get('etag');
    await first.text();

    // 改写文件内容
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("changed")', 'utf8');

    const second = await fetch(`${server.url}/assets/app.js`);
    const etagAfter = second.headers.get('etag');
    assert.notEqual(etagBefore, etagAfter, '内容变了 ETag 必须变');
    assert.match(await second.text(), /changed/);
  });
});
