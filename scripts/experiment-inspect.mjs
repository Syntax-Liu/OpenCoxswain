/**
 * 细看改动后模型写的具体验收内容——确认 command 是**真的能跑**，
 * 不是"看起来像命令"的伪命令。
 */
import { readFileSync } from 'node:fs';

const KEY = readFileSync('D:\\Users\\37632\\Products\\OpenCoxswain\\..\\apikey.txt', 'utf8').trim();

const CRITERIA_SCHEMA = {
  type: 'array',
  description:
    '**验收标准**：怎么算这个 Agent做完了。至少写一条。\n\n' +
    '**优先用 command 或 diff，把 human 留到最后**。\n' +
    'command/diff 由系统自己跑、自己判，结果硬；human 只能人看。\n\n' +
    '写 command 的窍门：凡是「能跑一下就知道」的，都写命令。\n' +
    '  ✅「TypeScript 编译通过」→ command: pnpm -w typecheck\n' +
    '  ❌ 不要写无法机器验证的标准。',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'desc', 'type'],
    properties: {
      id: { type: 'string' },
      desc: { type: 'string' },
      type: { type: 'string', enum: ['command', 'diff', 'human'] },
      check: { type: 'string', description: 'type=command 时必填：要重跑的命令' },
    },
  },
};

const GOALS = [
  '在 apps/web/src/components 下新增一个 formatCount.ts，导出 formatCount(n: number): string，超过 1000 显示为 1.2k。',
  '调研当前项目的前端状态管理方案是否合理，给出改进建议。',
];

for (const goal of GOALS) {
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
                criteria: CRITERIA_SCHEMA,
              },
            },
          },
        },
      ],
    }),
  });
  const json = await res.json();
  const call = json.choices?.[0]?.message?.tool_calls?.[0];
  console.log(`\n场景：${goal.slice(0, 40)}…\n`);
  if (!call) {
    console.log('  （没有调用工具）');
    continue;
  }
  const args = JSON.parse(call.function.arguments);
  for (const c of args.criteria ?? []) {
    const check = c.check ? `\n        命令: ${c.check}` : '';
    console.log(`  [${c.type}] ${c.desc}${check}`);
  }
}
