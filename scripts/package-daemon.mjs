import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 daemon 与工作区包的构建产物摊平到 Tauri 资源目录：
 * staging/
 *   daemon/{package.json,dist}
 *   node_modules/@opencoxswain/{shared,core,adapters,plugin-api,memory}/{package.json,dist}
 *   runtime/{node.exe,LICENSE,version.txt}
 * 自带 Node 运行时后，安装包不再依赖用户预装的 Node.js；构建机仍需 Node >= 22。
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

// 把构建机上的 Node 运行时一并带走：目标机器不再需要预装 Node。
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (process.platform !== 'win32' || nodeMajor < 22) {
  throw new Error(`打包需要 Windows 且 Node >= 22（当前 ${process.platform} / ${process.versions.node}）`);
}
const runtimeTarget = path.join(staging, 'runtime');
mkdirSync(runtimeTarget, { recursive: true });
cpSync(process.execPath, path.join(runtimeTarget, 'node.exe'));
// Node.js 以 MIT 许可证分发，二进制随包分发时要带上许可证原文。
const licenseSource = path.join(path.dirname(process.execPath), 'LICENSE');
if (existsSync(licenseSource)) {
  cpSync(licenseSource, path.join(runtimeTarget, 'LICENSE'));
}
writeFileSync(
  path.join(runtimeTarget, 'version.txt'),
  `Node.js ${process.versions.node}\n`,
  'utf8',
);

console.log(`daemon 资源已打包到 ${staging}（含 Node.js ${process.versions.node} 运行时）`);
