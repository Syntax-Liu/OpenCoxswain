/**
 * 对照实验：验证验收类型的提示词引导有没有效果。
 *
 * 直接问模型同一个派活场景，看它写出什么类型的 criteria。
 * 不经过完整运行时，只测模型这一层——能快速分辨
 * 「提示词没用」和「整条链路丢信息」两种情况。
 *
 * 用法：node scripts/experiment-criteria.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEY = readFileSync('D:\\Users\\37632\\Products\\OpenCoxswain\\..\\apikey.txt', 'utf8').trim();
const URL = 'https://api.deepseek.com/v1/chat/completions';

/** 当前的 spawn_executor criteria schema（从 prompt.ts 抄来，保持同步）。 */
const SCHEMA = {
  type: 'array',
  description:
    '**验收标准**：怎么算这个 Agent做完了。至少写一条。\n\n' +
    '**优先用 command 或 diff，把 human 留到最后**。原因：\n' +
    '- command/diff 由系统自己跑、自己判，结果硬；\n' +
    '- human 只能人看，会让用户每完成一步就被问一次。\n' +
    '方案批过一次之后不该再逐步打扰用户，所以能写成命令就必须写成命令。\n\n' +
    '写 command 的窍门：凡是「能跑一下就知道」的，都写命令。\n' +
    '  ✅「TypeScript 编译通过」→ command: pnpm -w typecheck\n' +
    '  ✅「测试全过」→ command: node --test\n' +
    '  ✅「没有留下临时文件」→ command: git status --porcelain\n' +
    '  ✅「只改了 src/auth 下的文件」→ diff 类型即可\n' +
    '  ❌ 不要写「代码质量良好」「输出未被编造」这类无法机器验证的标准；\n' +
    '     真要表达，换成可执行的替身（如 lint 通过、输出里含特定字段）。\n\n' +
    '**只有纯判断类任务**（调研、方案设计、需要人做取舍）才用 human。',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'desc', 'type'],
    properties: {
      id: { type: 'string', description: '短标识，如 build / tests' },
      desc: { type: 'string', description: '人话描述，如「TypeScript 编译通过」' },
      type: {
        type: 'string',
        enum: ['command', 'diff', 'human'],
        description:
          'command=由系统重跑一条命令看退出码（**首选**）/ diff=由系统统计改动（**次选**）/' +
          'human=需要人看（只在无法机器验证时用）',
      },
      check: {
        type: 'string',
        description:
          'type=command 时**必填**：要重跑的命令，如 pnpm -w typecheck。' +
          '必须是只读、幂等、能在几秒到几分钟内跑完的命令。',
      },
    },
  },
};

/** 对照：改动前的旧 schema 描述。 */
const OLD_SCHEMA = {
  ...SCHEMA,
  description:
    '**验收标准**：怎么算这个 Agent做完了。强烈建议至少写一条。' +
    '没有标准的话，系统无法复核，只能靠人看结论。',
  items: {
    ...SCHEMA.items,
    properties: {
      ...SCHEMA.items.properties,
      type: {
        type: 'string',
        enum: ['command', 'diff', 'human'],
        description: 'command=由系统重跑一条命令看退出码 / diff=由系统统计改动 / human=需要人看',
      },
    },
  },
};

/** 三个典型派活场景。 */
const SCENARIOS = [
  {
    name: '有明确产出的（改代码）',
    goal: '在 apps/web/src/components 下新增一个 formatCount.ts，导出 formatCount(n: number): string，超过 1000 显示为 1.2k。',
  },
  {
    name: '只读分析的（查问题）',
    goal: '检查 apps/web/src/components/RunnerLane.tsx 里 laneStatusOf 是否覆盖了所有 ExecutorStatus 分支。',
  },
  {
    name: '纯判断的（调研）',
    goal: '调研当前项目的前端状态管理方案是否合理，给出改进建议。',
  },
];

async function ask(goal, schema) {
  const body = {
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content:
          '你是一个多 Agent 系统的 Assistant，负责把用户需求拆成可执行的 Agent 任务。' +
          '当你要派活时，调用 spawn_executor 工具。',
      },
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
            additionalProperties: false,
            required: ['label', 'goal', 'writeScope', 'criteria'],
            properties: {
              label: { type: 'string', description: '任务短名' },
              goal: { type: 'string', description: '完整目标' },
              writeScope: { type: 'array', items: { type: 'string' } },
              criteria: schema,
            },
          },
        },
      },
    ],
    temperature: 0,
  };

  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  return JSON.parse(call.function.arguments);
}

function tally(args) {
  const out = { command: 0, diff: 0, human: 0, none: 0, hasCheck: 0 };
  if (!args?.criteria || args.criteria.length === 0) {
    out.none = 1;
    return out;
  }
  for (const c of args.criteria) {
    if (c.type in out) out[c.type] += 1;
    if (c.type === 'command' && c.check) out.hasCheck += 1;
  }
  return out;
}

console.log('对照实验：验收类型分布\n');

for (const [label, schema] of [
  ['【改动前】强烈建议至少写一条', OLD_SCHEMA],
  ['【改动后】优先 command/diff', SCHEMA],
]) {
  console.log(label);
  let total = { command: 0, diff: 0, human: 0, none: 0, hasCheck: 0 };
  for (const s of SCENARIOS) {
    let args;
    try {
      args = await ask(s.goal, schema);
    } catch (e) {
      console.log(`  ✗ ${s.name}: ${e.message}`);
      continue;
    }
    const t = tally(args);
    for (const k of Object.keys(total)) total[k] += t[k];
    console.log(
      `  ${s.name}: command=${t.command} diff=${t.diff} human=${t.human}` +
        (t.none ? ' （没写验收）' : ''),
    );
  }
  const sum = total.command + total.diff + total.human;
  const machine = total.command + total.diff;
  console.log(
    `  → 合计 ${sum} 条，其中机器可判 ${machine} 条` +
      `${sum > 0 ? `（${Math.round((machine / sum) * 100)}%）` : ''}\n`,
  );
}
