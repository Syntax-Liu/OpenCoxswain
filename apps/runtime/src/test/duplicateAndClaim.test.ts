import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * 2026-11-16 用户三张截图暴露的问题。
 *
 * ## 图 2：同一段显示两遍
 *
 *     Assistant
 *       结论：已派出只读 Agent 统计 docs…
 *       做了什么：派出一个 writeScope 为 readonly 的 Agent…
 *
 *     Assistant                    ← 又一遍
 *       我先派一个只读 Agent 去统计。结论：已派出只读 Agent…
 *       做了什么：派出一个 writeScope 为 readonly 的 Agent…
 *
 * 原因：模型的真答复（final=true）**会把调工具前的说明一起重说一遍**，
 * 而前端无脑追加，就拼成了两遍。
 *
 * ## 图 1：说"已派出"却没派
 *
 *    结论：已派出了一个 Agent ... (id: exe_mwj36qo914pz8)
 *    （注：上面这句话只是预告，没有真的派出去。需要的话说一声。）
 *
 * 检测抓到了，但因为是"汇报轮"所以只提示、不重试。
 * 根因：`reportingTurn` 扫的是**整个历史**，只要历史里有过结算通知就永远成立。
 *
 * ## 图 1 右栏：40 轮上限
 *
 *     Agent「读取仓库内容概览」未完成。达到单轮最大轮次 40
 *
 * 只读任务要读很多文件，40 步不够。
 */

describe('**同一段不显示两遍**', () => {
  const api = readFileSync(new URL('../../../web/src/api.ts', import.meta.url), 'utf8');
  const state = readFileSync(new URL('../../../web/src/state.ts', import.meta.url), 'utf8');
  const orch = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('api 的 assistant_text 带 final 字段', () => {
    assert.match(api, /readonly final\?: boolean/, 'assistant_text 没有 final');
  });

  it('runtime 把 final 传出去', () => {
    assert.match(orch, /final: event\.final/, 'runtime 没传 final');
  });

  it('前端按 final 决定追加还是替换', () => {
    assert.match(state, /event\.final !== false \? 'replace' : 'append'/, '前端没按 final 区分');
  });

  it('mergeAssistantText 支持 replace', () => {
    assert.match(state, /mode: 'append' \| 'replace'/, 'mergeAssistantText 没有 mode 参数');
  });

  it('**replace 有时间窗保护**（不覆盖上一轮）', () => {
    const start = state.indexOf('export function mergeAssistantText');
    const block = state.slice(start, start + 1400);
    assert.match(block, /2 \* 60_000/, 'replace 没有时间窗，会覆盖上一轮的真答复');
  });
});

describe('**说谎要重试，不能只提示**', () => {
  const orch = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('reportingTurn 只看本轮输入，不扫整个历史', () => {
    const start = orch.indexOf('const reportingTurn');
    assert.ok(start > 0);
    const block = orch.slice(start, start + 300);
    assert.match(block, /inputs\.some/, 'reportingTurn 还在扫历史 —— 谎报永远不重试');
    assert.ok(!/messages\.some/.test(block), 'reportingTurn 还在用 messages.some');
  });
});

describe('**40 轮上限太低**', () => {
  const orch = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('默认步数至少 80', () => {
    assert.match(orch, /maxStepsPerExecutor \?\? 80/, '默认步数还是 40，只读任务会被砍断');
  });
});
