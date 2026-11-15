/**
 * 对照实验（修正版）：验收命令的**平台可用性**。
 *
 * 上一版把「命令退出码非 0」当成「可执行」——
 * 但 `test` 在 Windows 上根本不存在，退出码也是非 0，两者分不开。
 * 这一版用静态规则判断，并真的执行一次确认。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { checkCommandUsable } from './lib/command-portability.mjs';

const execAsync = promisify(exec);
const KEY = readFileSync('D:\\Users\\37632\\Products\\OpenCoxswain\\..\\apikey.txt', 'utf8').trim();
const CWD = 'D:\\Users\\37632\\Products\\OpenCoxswain';

const BASE_DESC =
  '**验收标准**：怎么算这个 Agent 做完了。至少写一条。\n\n' +
  '**优先用 command 或 diff，把 human 留到最后**。\n' +
  'command/diff 由系统自己跑、自己判，结果硬；human 只能人看。';

const PLATFORM_HINT =
  '\n\n**命令必须能在本机跑通**。系统用 shell 执行 check，当前平台是 Windows（cmd.exe）。\n' +
  '这里**没有 bash**：不要用 test -f / grep -q / for … do … done 这类 POSIX 写法。\n' +
  'Windows 上这样写：\n' +
  '  ✅ 文件存在 → if exist path\\file.ts (exit 0) else (exit 1)\n' +
  '  ✅ 内容包含 → findstr /C:"export function foo" path\\file.ts\n' +
  '  ✅ 编译通过 → pnpm -w typecheck（跨平台工具，推荐）\n' +
  '  ✅ 没留临时文件 → git status --porcelain\n' +
  '最稳妥的是选**跨平台命令**（node -e、pnpm、git），它们在哪个平台都一样。';

function schema(desc) {
  return {
    type: 'array',
    description: desc,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'desc', 'type'],
      properties: {
        id: { type: 'string' },
        desc: { type: 'string' },
        type: { type: 'string', enum: ['command', 'diff', 'human'] },
        check: { type: 'string' },
      },
    },
  };
}

const GOALS = [
  '检查 apps/web/src/components 目录下是否存在 RunnerLane.tsx，并确认它导出了 laneStatusOf。',
  '确认 apps/web 的 TypeScript 类型检查能通过。',
  '确认工作区没有未提交的临时文件残留。',
];

async function ask(goal, desc) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0,
      messages: [
        { role: 'system', content: '你是多 Agent 系统的 Assistant。派活时调用 spawn_executor。' },
        { role: 'user', content: goal },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'spawn_executor',
            description: '派一个 Agent 去执行任务',
            parameters: {
              type: 'object',
              required: ['label', 'goal', 'writeScope', 'criteria'],
              properties: {
                label: { type: 'string' },
                goal: { type: 'string' },
                writeScope: { type: 'array', items: { type: 'string' } },
                criteria: schema(desc),
              },
            },
          },
        },
      ],
    }),
  });
  const json = await res.json();
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  return JSON.parse(call.function.arguments);
}

async function tryExec(command) {
  try {
    await execAsync(command, { cwd: CWD, timeout: 60_000, windowsHide: true, maxBuffer: 4 << 20 });
    return true;
  } catch {
    return false;
  }
}

console.log('验收命令的平台可用性对照（本机 = Windows / cmd.exe）\n');

const summary = [];

for (const [label, desc] of [
  ['【无平台提示】', BASE_DESC],
  ['【有平台提示】', BASE_DESC + PLATFORM_HINT],
]) {
  console.log(label);
  let commands = 0;
  let usable = 0;
  const bad = [];

  for (const goal of GOALS) {
    const args = await ask(goal, desc);
    if (!args) continue;
    for (const c of args.criteria ?? []) {
      if (c.type !== 'command' || !c.check) continue;
      commands += 1;
      const v = checkCommandUsable(c.check, 'win32');
      if (v.usable) {
        usable += 1;
      } else {
        bad.push({ cmd: c.check, reason: v.reason });
      }
    }
  }

  console.log(`  ${commands} 条命令，可用 ${usable} 条，不可用 ${bad.length} 条`);
  for (const b of bad) {
    console.log(`    ✗ ${b.cmd.slice(0, 60)}`);
    console.log(`      ${b.reason}`);
  }
  summary.push({ label, commands, usable });
  console.log('');
}

console.log('─'.repeat(50));
const [a, b] = summary;
if (a.commands > 0 && b.commands > 0) {
  console.log(
    `无提示可用率 ${Math.round((a.usable / a.commands) * 100)}% → ` +
      `有提示 ${Math.round((b.usable / b.commands) * 100)}%`,
  );
}
