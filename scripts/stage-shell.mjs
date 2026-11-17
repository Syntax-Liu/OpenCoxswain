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
import { cp, mkdir, readdir, readFile, rm, stat, copyFile } from 'node:fs/promises';
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
/**
 * 目录内容是否与源完全一致（按相对路径 + 字节）。
 *
 * 用来决定"还要不要重新复制"：`staging/` 是 tauri.conf.json 里的
 * `bundle.resources`，Cargo 会把它的内容嵌进可执行体。
 * **只要 staging 里的文件 mtime 变了，Cargo 就认为 opencoxswain 变了，
 * 整个二进制要重编一次（约 2 分半）。**
 *
 * 而 `rm -rf` + `cp` 每次都重写所有文件——哪怕内容一个字节都没变。
 * 于是"改了一行前端代码再出包"也要花 4 分钟，这是出包慢的最大原因。
 */
async function sameContent(srcDir, destDir) {
  if (!existsSync(destDir)) return false;

  async function walk(dir, base = '') {
    const out = new Map();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        for (const [k, v] of await walk(path.join(dir, e.name), rel)) out.set(k, v);
      } else {
        const st = await stat(path.join(dir, e.name));
        out.set(rel, st.size);
      }
    }
    return out;
  }

  const [a, b] = await Promise.all([walk(srcDir), walk(destDir)]);
  if (a.size !== b.size) return false;
  for (const [rel, size] of a) {
    if (b.get(rel) !== size) return false;
  }
  // 大小相同还不够（同尺寸不同内容），再比一次哈希
  for (const rel of a.keys()) {
    const [x, y] = await Promise.all([
      readFile(path.join(srcDir, rel)),
      readFile(path.join(destDir, rel)),
    ]);
    if (!x.equals(y)) return false;
  }
  return true;
}

async function main() {
  console.log(`[stage-shell] 仓库根：${repoRoot}`);
  console.log(`[stage-shell] 目标：${staging}`);

  const runtimeDist = path.join(repoRoot, 'apps', 'runtime', 'dist');
  if (!existsSync(path.join(runtimeDist, 'cli.js'))) {
    throw new Error(
      `找不到 ${path.join(runtimeDist, 'cli.js')}，请先运行 pnpm --filter @opencoxswain/runtime build`,
    );
  }

  const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
  if (!existsSync(path.join(webDist, 'index.html'))) {
    throw new Error(
      `找不到 ${path.join(webDist, 'index.html')}，请先运行 pnpm --filter @opencoxswain/web build`,
    );
  }

  // 先判断整体是否一致。一致就**一个字节都不动**，让它保持原有 mtime，
  // Cargo 于是不会重编 opencoxswain——这就是增量出包几十秒就完成的原因。
  const [runtimeSame, webSame] = await Promise.all([
    sameContent(runtimeDist, path.join(staging, 'runtime')),
    sameContent(webDist, path.join(staging, 'web')),
  ]);

  if (runtimeSame && webSame) {
    console.log('[stage-shell] 内容未变，跳过复制（保持 mtime，避免 Cargo 重编）');
    // 仍然要清掉 target/release 里遗留的副本，否则 tauri 会用旧资源。
    await cleanTargetStaging();
    // node 也按同样规则处理：大小没变就不覆盖
    const nodeSrc =
      process.env.OPENCOXSWAIN_NODE_BIN ??
      (process.platform === 'win32' ? process.execPath : undefined);
    if (nodeSrc && existsSync(nodeSrc)) {
      const info = await stat(nodeSrc);
      if (info.isFile()) {
        const target = path.join(staging, 'node', path.basename(nodeSrc));
        if (!existsSync(target) || (await stat(target)).size !== info.size) {
          await mkdir(path.join(staging, 'node'), { recursive: true });
          await copyFile(nodeSrc, target);
          console.log(`[stage-shell] node 已复制：${target}`);
        }
      }
    }
    console.log('[stage-shell] 完成');
    return;
  }

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // 1) 运行时
  await cp(runtimeDist, path.join(staging, 'runtime'), { recursive: true });
  console.log('[stage-shell] runtime 已复制');

  // 2) 工作台
  await cp(webDist, path.join(staging, 'web'), { recursive: true });
  console.log('[stage-shell] web 已复制');

  // 3) 同时清掉 Tauri 上一次打包遗留的 staging 副本。
  //    tauri build 会把 staging 复制到 target/release/，那里同样会累积旧文件，
  //    而应用实际加载的是那一份。
  await cleanTargetStaging();

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
      // 内容没变就不覆盖——同理，避免无谓地更新 mtime 触发 Cargo 重编
      const same =
        existsSync(target) && (await stat(target)).size === info.size;
      if (!same) {
        await copyFile(nodeSource, target);
        console.log(`[stage-shell] node 已复制：${target}`);
      }
    }
  } else {
    console.log('[stage-shell] 未找到 Node 可执行体，安装包将回退系统 node');
  }

  console.log('[stage-shell] 完成');
}

/** 清掉 target/release 里 Tauri 上一次留下的 staging 副本。 */
async function cleanTargetStaging() {
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
}

main().catch((error) => {
  console.error(`[stage-shell] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
