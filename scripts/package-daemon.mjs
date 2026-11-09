import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 daemon 与工作区包的构建产物摊平到 Tauri 资源目录：
 * staging/
 *   daemon/{package.json,dist}
 *   node_modules/@opencoxswain/{shared,core,adapters,plugin-api,memory}/{package.json,dist}
 * 运行时只需要系统安装的 Node.js，不再依赖 pnpm 的符号链接。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, 'apps', 'desktop', 'src-tauri', 'staging');
const packages = ['shared', 'core', 'adapters', 'plugin-api', 'memory'];

function copyDist(source, target) {
  cpSync(path.join(source, 'dist'), path.join(target, 'dist'), {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}dist${path.sep}test`),
  });
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const daemonTarget = path.join(staging, 'daemon');
mkdirSync(daemonTarget, { recursive: true });
copyDist(path.join(root, 'apps', 'daemon'), daemonTarget);
const daemonManifest = JSON.parse(
  readFileSync(path.join(root, 'apps', 'daemon', 'package.json'), 'utf8'),
);
writeFileSync(
  path.join(daemonTarget, 'package.json'),
  `${JSON.stringify(
    {
      name: daemonManifest.name,
      version: daemonManifest.version,
      private: true,
      type: 'module',
      main: './dist/index.js',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

for (const name of packages) {
  const source = path.join(root, 'packages', name);
  const target = path.join(staging, 'node_modules', '@opencoxswain', name);
  mkdirSync(target, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: true,
        type: 'module',
        main: manifest.main,
        types: manifest.types,
        exports: manifest.exports,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  copyDist(source, target);
}

console.log(`daemon 资源已打包到 ${staging}`);
