/**
 * 命令输出截断测试。
 *
 * 核心约束：**失败信息不能被截掉**。
 *
 * 实测：全量测试输出 34685 字符，工具上限 4000。
 * 简单 slice(0, 4000) 只保留前 11%，而失败摘要通常在末尾——
 * Agent 看到一堆通过的测试，失败那条被截掉了。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trimCommandOutput } from '../executor/executor.js';

describe('短输出', () => {
  it('不超限时原样返回', () => {
    const text = '全部通过';
    assert.equal(trimCommandOutput(text, 4000), text);
  });

  it('刚好等于上限时也原样返回', () => {
    const text = 'x'.repeat(100);
    assert.equal(trimCommandOutput(text, 100), text);
  });
});

describe('**长输出保留尾部**', () => {
  it('超限时保留开头和结尾', () => {
    const head = 'A'.repeat(2000);
    const mid = 'M'.repeat(10000);
    const tail = 'Z'.repeat(2000);
    const out = trimCommandOutput(head + mid + tail, 4000);

    assert.ok(out.startsWith('A'), '应保留开头');
    assert.ok(out.endsWith('read_file 读它。）'), '应以说明结尾');
    assert.ok(out.includes('Z'.repeat(100)), '**结尾内容必须保留**');
  });

  it('**末尾的失败信息不会丢**', () => {
    // 模拟真实测试输出：大量通过 + 末尾一条失败
    const passing = 'ok 1 test\n'.repeat(2000);
    const failure = 'not ok 843 - 排序测试失败';
    const out = trimCommandOutput(passing + failure, 4000);

    assert.ok(out.includes(failure), `失败信息必须在截断后仍可见，实际输出：${out.slice(-200)}`);
  });

  it('标注省略了多少', () => {
    const out = trimCommandOutput('x'.repeat(10000), 1000);
    assert.match(out, /省略 \d+ 字符/);
  });

  it('告诉 Agent 怎么拿完整输出', () => {
    const out = trimCommandOutput('x'.repeat(10000), 1000);
    assert.match(out, /重定向到文件/);
    assert.match(out, /read_file/);
  });
});

describe('尾部优先', () => {
  it('**尾部空间比头部多**', () => {
    const marker = 'TAIL_MARKER';
    const text = 'H'.repeat(5000) + marker + 'T'.repeat(5000);
    const out = trimCommandOutput(text, 1000);

    // 尾部给 70%，所以靠近末尾的内容更容易留下
    assert.ok(out.includes('T'.repeat(500)), '尾部应保留大段内容');
  });
});

describe('边界', () => {
  it('空字符串不崩', () => {
    assert.equal(trimCommandOutput('', 4000), '');
  });

  it('上限很小时仍可用', () => {
    const out = trimCommandOutput('x'.repeat(1000), 50);
    assert.ok(out.length > 0);
    assert.match(out, /省略/);
  });
});
