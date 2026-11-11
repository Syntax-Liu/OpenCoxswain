#!/usr/bin/env node
/**
 * 生成自动更新清单 latest.json，以及发布所需文件的清单。
 *
 * 为什么需要它：Tauri 的 updater 会去 `endpoints` 指定的地址拉一个 JSON，
 * 里面有版本号、下载地址和**签名**。签名由构建时的私钥产生，
 * 客户端用配置里的公钥校验——对不上就拒绝安装。这是防中间人替换的唯一保障。
 *
 * 用法：
 *   node scripts/make-latest-json.mjs
 *
 * 产出：apps/shell/src-tauri/target/release/bundle/nsis/latest.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nsisDir = path.join(root, 'apps/shell/src-tauri/target/release/bundle/nsis');

const GITHUB_REPO = 'Syntax-Liu/OpenCoxswain';

async function main() {
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const installer = `OpenCoxswain_${version}_x64-setup.exe`;
  const installerPath = path.join(nsisDir, installer);

  let signature;
  try {
    signature = (await readFile(`${installerPath}.sig`, 'utf8')).trim();
  } catch {
    console.error(`找不到签名文件：${installer}.sig`);
    console.error('请确认构建时设置了 TAURI_SIGNING_PRIVATE_KEY。');
    process.exit(1);
  }

  try {
    await readFile(installerPath);
  } catch {
    console.error(`找不到安装包：${installer}`);
    process.exit(1);
  }

  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${installer}`,
      },
    },
  };

  const out = path.join(nsisDir, 'latest.json');
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('已生成 latest.json：');
  console.log(JSON.stringify(manifest, null, 2));
  console.log('');
  console.log('发布时把这三个文件一起上传到 GitHub Releases：');
  console.log(`  ${installer}`);
  console.log(`  ${installer}.sig`);
  console.log('  latest.json');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
