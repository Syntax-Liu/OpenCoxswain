#!/usr/bin/env node
/**
 * 发布一个 GitHub Release（含安装包、签名、更新清单）。
 *
 * **私有仓库也能用**：Release 会出现在仓库的 Releases 页面，
 * 只是匿名访问不到 latest.json。你自己测试时下载要用带权限的登录态。
 *
 * 用法：
 *   node scripts/publish-release.mjs --dry-run   # 只检查，不上传
 *   node scripts/publish-release.mjs             # 真正发布
 *
 * 令牌来源（按优先级）：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. git 凭据管理器里的 github.com 凭据
 */
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Syntax-Liu/OpenCoxswain';
const NSIS = path.join(ROOT, 'apps/shell/src-tauri/target/release/bundle/nsis');
const DRY = process.argv.includes('--dry-run');

function tokenFromGit() {
  try {
    const raw = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      cwd: ROOT,
    });
    return /^password=(.+)$/m.exec(raw)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

const token = process.env.GITHUB_TOKEN?.trim() || tokenFromGit();
if (!token) {
  console.error('拿不到 GitHub 令牌。请设置 GITHUB_TOKEN，或在 git 凭据里存放 github.com 凭据。');
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'opencoxswain-release',
  'x-github-api-version': '2022-11-28',
};

async function api(pathname, init = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} → ${res.status}: ${String(text).slice(0, 300)}`);
  }
  return body;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;

  const installer = `OpenCoxswain_${version}_x64-setup.exe`;
  const sigFile = `${installer}.sig`;
  const manifest = 'latest.json';

  console.log(`发布 ${tag}`);

  // 0. **发布前自检**：判据不满足就停下。
  //
  // 之前"能不能发"是凭感觉的。这一轮有 6 个 bug 是"测试全绿但功能不工作"，
  // 所以把判据固化成代码，卡在这里。
  {
    let output;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, 'scripts/release-ready.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      output = String(error.stdout ?? '');
      // 退出码非 0 = 不能发。把结论打出来再中止。
      for (const line of output.trim().split('\n').slice(1)) console.log('  ' + line);
      console.error('\n发布前自检未通过，已中止。修完上面列出的问题再发。');
      process.exit(1);
    }
    for (const line of output.trim().split('\n').slice(1)) console.log('  ' + line);
  }

  // 1. 确认产物齐全
  for (const name of [installer, sigFile, manifest]) {
    const info = await stat(path.join(NSIS, name)).catch(() => null);
    if (!info) {
      console.error(`缺少产物：${name}`);
      console.error('请先运行 build-app.cmd 出包。');
      process.exit(1);
    }
    console.log(`  ✓ ${name}（${(info.size / 1024 / 1024).toFixed(1)} MB）`);
  }

  // 2. 检查清单版本与当前一致
  const latest = JSON.parse(await readFile(path.join(NSIS, manifest), 'utf8'));
  if (latest.version !== version) {
    console.error(`latest.json 里的版本是 ${latest.version}，与 package.json 的 ${version} 不一致。`);
    console.error('请重新运行 node scripts/make-latest-json.mjs。');
    process.exit(1);
  }

  // 3. 确认仓库状态（不改变可见性）
  const repo = await api(`/repos/${REPO}`);
  console.log(`  仓库：${repo.full_name}，private=${repo.private}`);

  if (DRY) {
    console.log('\n[dry-run] 检查通过，未上传。');
    return;
  }

  // 4. 创建或复用 release
  let release;
  try {
    release = await api(`/repos/${REPO}/releases/tags/${tag}`);
    console.log(`  已存在同名 Release，将复用（id=${release.id}）`);
  } catch (error) {
    if (!String(error).includes('404')) throw error;
    release = await api(`/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `OpenCoxswain ${tag}`,
        body: [
          `## 安装`,
          '',
          '1. 下载 `' + installer + '` 并安装',
          '2. Windows 会提示"未知发布者"（未购买代码签名证书），点 **更多信息 → 仍要运行**',
          '3. 启动后在设置里填模型密钥',
          '',
          '## 自动更新',
          '',
          '本 Release 同时提供签名与 `latest.json`。',
          '**仓库目前是私有的**，所以应用内自动更新暂时拉不到清单——',
          '需要手动到此页面下载安装。',
        ].join('\n'),
        draft: false,
        prerelease: false,
      }),
    });
    console.log(`  已创建 Release（id=${release.id}）`);
  }

  // 5. 上传资产（已存在的先删掉，保证是最新的）
  const existing = await api(`/repos/${REPO}/releases/${release.id}/assets`);
  const uploadRoot = 'https://uploads.github.com';

  for (const name of [installer, sigFile, manifest]) {
    const old = existing.find((asset) => asset.name === name);
    if (old) {
      await api(`/repos/${REPO}/releases/assets/${old.id}`, { method: 'DELETE' });
      console.log(`  删除旧资产 ${name}`);
    }

    const bytes = await readFile(path.join(NSIS, name));
    const res = await fetch(
      `${uploadRoot}/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: bytes,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error(`  上传 ${name} 失败：${res.status} ${text.slice(0, 200)}`);
      process.exit(1);
    }
    console.log(`  已上传 ${name}`);
  }

  console.log(`\n完成：https://github.com/${REPO}/releases/tag/${tag}`);
  console.log('（仓库为私有，需要登录 GitHub 才能下载）');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
