#!/usr/bin/env node
/**
 * 版本号统一管理。
 *
 * 问题：版本号散落在 6 个文件里（根 package.json、三个子包、Cargo.toml、
 * tauri.conf.json），手工改极易漏掉某个，导致安装包版本与 package.json 不一致。
 *
 * 做法：以根 package.json 的 version 为**唯一来源**，`sync` 把它写进其余位置。
 *
 * 用法：
 *   node scripts/version.mjs sync          # 把根版本同步到各处
 *   node scripts/version.mjs bump patch    # 提升补丁号并同步
 *   node scripts/version.mjs bump minor
 *   node scripts/version.mjs bump major
 *   node scripts/version.mjs show
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** 需要跟随根版本的包（内部包，一起发版）。 */
const JSON_TARGETS = [
  'package.json',
  'apps/runtime/package.json',
  'apps/web/package.json',
  'apps/shell/package.json',
  'apps/shell/src-tauri/tauri.conf.json',
];

const CARGO_TARGET = 'apps/shell/src-tauri/Cargo.toml';

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(root, rel), 'utf8'));
}

async function writeJson(rel, value) {
  // 保持 2 空格缩进与结尾换行，避免产生无意义 diff。
  await writeFile(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseSemver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) throw new Error(`版本号不是 x.y.z 形式：${text}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function bump(current, kind) {
  const v = parseSemver(current);
  switch (kind) {
    case 'major':
      return `${v.major + 1}.0.0`;
    case 'minor':
      return `${v.major}.${v.minor + 1}.0`;
    case 'patch':
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      throw new Error(`未知的提升类型：${kind}（可选 patch / minor / major）`);
  }
}

async function sync() {
  const rootPkg = await readJson('package.json');
  const version = rootPkg.version;
  parseSemver(version); // 校验格式

  for (const rel of JSON_TARGETS) {
    const pkg = await readJson(rel);
    if (pkg.version === version) continue;
    pkg.version = version;
    await writeJson(rel, pkg);
    console.log(`  更新 ${rel} → ${version}`);
  }

  // Cargo.toml 只在 [package] 段里的 version 行改，不动依赖的版本。
  const cargoPath = path.join(root, CARGO_TARGET);
  const cargo = await readFile(cargoPath, 'utf8');
  const updated = cargo.replace(
    /(\nversion = ")([^"]+)(")/,
    (_m, pre, _old, post) => `${pre}${version}${post}`,
  );
  if (updated !== cargo) {
    await writeFile(cargoPath, updated, 'utf8');
    console.log(`  更新 ${CARGO_TARGET} → ${version}`);
  }

  console.log(`版本号已统一为 ${version}`);
}

async function main() {
  const [, , command, arg] = process.argv;

  if (command === 'show' || command === undefined) {
    const pkg = await readJson('package.json');
    console.log(pkg.version);
    return;
  }

  if (command === 'sync') {
    await sync();
    return;
  }

  if (command === 'bump') {
    const pkg = await readJson('package.json');
    pkg.version = bump(pkg.version, arg ?? 'patch');
    await writeJson('package.json', pkg);
    console.log(`版本 → ${pkg.version}`);
    await sync();
    return;
  }

  console.error(`未知命令：${command}`);
  console.error('用法：node scripts/version.mjs [sync|bump patch|minor|major|show]');
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
