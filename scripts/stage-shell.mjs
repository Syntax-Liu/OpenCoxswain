#!/usr/bin/env node
/**
 * 把运行时与工作台产物摊平进桌面壳的打包资源目录。
 *
 * 产物结构：
 * ```
 * apps/shell/src-tauri/staging/
 *   runtime/           runningtime 的 dist（cli.js + 依赖）
 *   web/               工作台构建产物（index.html + assets）
 *   node/              可选：自带 Node 运行时（node.exe）
 * ```
 *
 * 为什么摊平而不是保留 monorepo 结构：
 * Tauri 的 resources 只搬运指定目录，摊平后入口路径稳定，
 * 而且运行时本身零外部依赖，不需要 node_modules。
 */
import { cp, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const staging = path.join(repoRoot, 'apps', 'shell', 'src-tauri', 'staging');

/**
 * 清理目标目录。
 *
 * 必须清：`cp` 是合并而不是替换，第三次构建后 assets 里会堆着
 * 三代带哈希的 JS/CSS，打包体积虚高，而且旧文件会一直跟着发版走。
 */
async function main() {
  console.log(`[stage-shell] 仓库根：${repoRoot}`);
  console.log(`[stage-shell] 目标：${staging}`);

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // 1) 运行时
  const runtimeDist = path.join(repoRoot, 'apps', 'runtime', 'dist');
  if (!existsSync(path.join(runtimeDist, 'cli.js'))) {
    throw new Error(
      `找不到 ${path.join(runtimeDist, 'cli.js')}，请先运行 pnpm --filter @opencoxswain/runtime build`,
    );
  }
  await cp(runtimeDist, path.join(staging, 'runtime'), { recursive: true });
  console.log('[stage-shell] runtime 已复制');

  // 2) 工作台
  const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
  if (!existsSync(path.join(webDist, 'index.html'))) {
    throw new Error(
      `找不到 ${path.join(webDist, 'index.html')}，请先运行 pnpm --filter @opencoxswain/web build`,
    );
  }
  await cp(webDist, path.join(staging, 'web'), { recursive: true });
  console.log('[stage-shell] web 已复制');

  // 3) 同时清掉 Tauri 上一次打包遗留的 staging 副本。
  //    tauri build 会把 staging 复制到 target/release/，那里同样会累积旧文件，
  //    而应用实际加载的是那一份。
  const targetStaging = path.join(
    repoRoot,
    'apps',
    'shell',
    'src-tauri',
    'target',
    'release',
    'staging',
  );
  if (existsSync(targetStaging)) {
    await rm(targetStaging, { recursive: true, force: true });
    console.log('[stage-shell] 已清理上一次打包的 staging 副本');
  }

  // 3) 自带的 Node 运行时（可选）
  //    安装包是否自带 Node 取决于构建机；没有就回退系统 node（壳里已处理）。
  const nodeSource =
    process.env.OPENCOXSWAIN_NODE_BIN ??
    (process.platform === 'win32' ? process.execPath : undefined);
  if (nodeSource && existsSync(nodeSource)) {
    const info = await stat(nodeSource);
    // 只在是单文件可执行体（node.exe）时复制，避免搬进整个安装目录。
    if (info.isFile()) {
      await mkdir(path.join(staging, 'node'), { recursive: true });
      const target = path.join(staging, 'node', path.basename(nodeSource));
      await copyFile(nodeSource, target);
      console.log(`[stage-shell] node 已复制：${target}`);
    }
  } else {
    console.log('[stage-shell] 未找到 Node 可执行体，安装包将回退系统 node');
  }

  console.log('[stage-shell] 完成');
}

main().catch((error) => {
  console.error(`[stage-shell] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
