#!/usr/bin/env node
/**
 * 本地自动更新服务器（仅用于验证更新链路）。
 *
 * 为什么需要它：真实更新走 GitHub Releases，但
 * 1. 仓库是私有的，匿名拉不到 latest.json；
 * 2. 就算公开也不好测"签名不对要拒绝安装"这种负面情况。
 *
 * 所以这里起一个本地服务，行为与 GitHub Releases 一致：
 *
 *   GET /latest.json          → 版本清单（含签名）
 *   GET /<安装包文件名>        → 安装包本体
 *
 * 用法：
 *   node scripts/update-server.mjs --version 0.9.2 --port 47800
 *
 * 然后用环境变量把桌面客户端的 endpoints 指过来验证。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nsisDir = path.join(root, 'apps/shell/src-tauri/target/release/bundle/nsis');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', '47800'));
/** 要"发布"的版本；不填就用当前 package.json 的版本。 */
const version = arg('version', null);

async function currentVersion() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return version ?? pkg.version;
}

/** 动态生成清单：读当前构建产物的 .sig，保证签名与安装包一致。 */
async function buildManifest(v) {
  const installer = `OpenCoxswain_${v}_x64-setup.exe`;
  const signature = (await readFile(path.join(nsisDir, `${installer}.sig`), 'utf8')).trim();

  return {
    version: v,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `http://127.0.0.1:${port}/${installer}`,
      },
    },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const v = await currentVersion();

  try {
    if (url.pathname === '/latest.json') {
      const manifest = await buildManifest(v);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));

      console.log(`[update-server] 清单请求 → 版本 ${v}`);
      return;
    }

    // 安装包下载
    const name = path.basename(url.pathname);
    const file = path.join(nsisDir, name);
    const info = await stat(file).catch(() => null);
    if (!info) {
      res.writeHead(404).end('not found');
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
    });
    createReadStream(file).pipe(res);

    console.log(`[update-server] 下载 → ${name} (${Math.round(info.size / 1024 / 1024)} MB)`);
  } catch (error) {
    console.error('[update-server]', error instanceof Error ? error.message : error);
    res.writeHead(500).end(String(error));
  }
});

server.listen(port, '127.0.0.1', async () => {
  const v = await currentVersion();
  console.log(`更新服务器已启动：http://127.0.0.1:${port}`);
  console.log(`  GET http://127.0.0.1:${port}/latest.json   （版本 ${v}）`);
  console.log(`  产物目录：${nsisDir}`);
  console.log('');
  console.log('验证客户端请把 endpoints 指向：');
  console.log(`  http://127.0.0.1:${port}/latest.json`);
});
