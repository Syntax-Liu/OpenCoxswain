import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = [];
let closing = false;

function run(command, args, options = {}) {
  return spawn(command, args, { shell: isWindows, ...options });
}

function prefix(child, name) {
  const pipe = (stream, target) => {
    stream?.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      if (text) target.write(`[${name}] ${text}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function track(child, name) {
  children.push(child);
  prefix(child, name);
  child.on('exit', (code) => {
    if (closing) return;
    console.error(`[${name}] 已退出（code ${code ?? 'null'}）`);
    shutdown(code ?? 1);
  });
  return child;
}

console.log('构建工作区…');
const build = run('pnpm', ['build'], { stdio: ['ignore', 'pipe', 'pipe'] });
prefix(build, 'build');
await new Promise((resolve, reject) => {
  build.on('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`pnpm build 失败（code ${code}）`));
  });
});

console.log('启动 Daemon 与工作台…');
track(run('pnpm', ['--filter', '@opencoxswain/daemon', 'start'], { stdio: ['ignore', 'pipe', 'pipe'] }), 'daemon');
track(run('pnpm', ['--filter', '@opencoxswain/desktop', 'dev'], { stdio: ['ignore', 'pipe', 'pipe'] }), 'desktop');

console.log('工作台：http://127.0.0.1:5173');
console.log('Daemon：http://127.0.0.1:47821（Ctrl+C 退出）');
