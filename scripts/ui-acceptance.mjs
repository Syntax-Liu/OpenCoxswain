/**
 * 界面验收：一条命令跑完所有视觉检查，**任一失败即非 0**。
 *
 * ## 为什么要有这个入口
 *
 * 之前视觉检查是散的：`screenshot-pages` / `audit-ui-structure` /
 * `audit-live-contrast` / `check-css-structure` 各跑各的，而且
 * 旧的结构检查（已删除）根本不读退出码。结果是"检查通过了"这句话
 * 没有依据——手动测试清单里"0 溢出"是人眼看截图填的。
 *
 * 这里把它们串成一条链，任何一环失败整个命令失败。
 *
 * ## 用法
 *
 * ```bash
 * # 1. 先构建并起服务（隔离的 home，避免动你真实的设置）
 * pnpm build
 * node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47911
 *
 * # 2. 跑验收
 * pnpm ui:audit
 * ```
 *
 * 服务地址用 `OCX_URL` 覆盖，默认 `http://127.0.0.1:47911/`。
 *
 * ## 两种状态都要覆盖
 *
 * 界面有两种大状态，**两套主题 × 两种状态**都过才算数：
 *
 * | 状态 | 触发条件 | 为什么不能漏 |
 * | --- | --- | --- |
 * | 首次配置 | 运行时没配模型密钥 | 大白按钮、独立布局，最容易被漏检 |
 * | 正常工作台 | 已配好密钥 | 三栏布局、列表、输入区 |
 *
 * 之前只跑过后者，结果亮色主题下主按钮白字只有 **3.66:1** 一直没人发现。
 *
 * 想让体检跑"已配置"那一态，给服务配一个假密钥即可（它不会被真调用）：
 *
 * ```bash
 * HOME=.audit-home node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47911
 * printf '{"apiKey":"sk-audit-placeholder","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}' \
 *   > .audit-home/.opencoxswain/llm.json
 * ```
 *
 * ## 每一步在验什么
 *
 * | 步骤 | 验什么 | 失败意味着 |
 * | --- | --- | --- |
 * | structure | 溢出、遮挡、裁切文字、裸按钮 | 界面会「看起来坏了」 |
 * | contrast | 对比度（两种主题） | 字看不清 |
 * | css-structure | 花括号配对 | CSS 被改坏、后面的规则全失效 |
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47911/';

/** 顺序执行，前一步的结果不影响后一步——尽量一次报全所有问题。 */
const STEPS = [
  {
    id: 'structure',
    label: '结构：溢出 / 遮挡 / 裁切 / 裸按钮',
    script: 'scripts/audit-ui-structure.mjs',
    needsServer: true,
  },
  {
    id: 'contrast',
    label: '对比度（两种主题）',
    script: 'scripts/audit-live-contrast.mjs',
    needsServer: true,
  },
  {
    id: 'css-structure',
    label: 'CSS 结构（花括号配对）',
    script: 'scripts/check-css-structure.mjs',
    needsServer: false,
  },
];

function run(script) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [resolve(ROOT, script)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, OCX_URL: BASE },
      shell: false,
    });
    child.on('exit', (code, signal) => res({ code: code ?? (signal ? 1 : 0) }));
    child.on('error', () => res({ code: 1 }));
  });
}

async function serverAlive() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const missing = STEPS.filter((s) => !existsSync(resolve(ROOT, s.script)));
if (missing.length > 0) {
  console.error('缺少检查脚本：');
  for (const m of missing) console.error(`  · ${m.script}`);
  process.exit(3);
}

const results = [];

for (const step of STEPS) {
  if (step.needsServer) {
    if (!(await serverAlive())) {
      console.error(
        `\n✗ 服务没起来：${BASE}\n` +
          '  先跑：node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47911\n' +
          '  （或用 OCX_URL 指向已在跑的服务）',
      );
      process.exit(3);
    }
  }

  console.log(`\n━━━ ${step.label} ━━━`);
  const { code } = await run(step.script);
  results.push({ ...step, code, ok: code === 0 });
  if (code !== 0) console.log(`\n✗ ${step.label} 未通过（退出码 ${code}）`);
}

console.log('\n━━━ 汇总 ━━━');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log(`\n界面验收未通过：${failed.length} 项失败。`);
  process.exit(1);
}
console.log('\n界面验收通过。');
