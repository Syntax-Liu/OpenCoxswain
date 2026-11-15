/**
 * 轮次上限的语义测试。
 *
 * 2026-11-15 实测踩到的误解：
 * 两个任务因「达到单轮最大步数 40」失败，但界面显示 **93 步 / 58 步**。
 * 用户看到「93 步 / 上限 40」会以为是 bug。
 *
 * 真相：两者单位不同。
 *   - maxSteps 限的是**模型往返轮次**（一轮 = 一次 LLM 调用）
 *   - executor.metrics.steps 统计的是**工具调用总数**（一轮里可并发多个）
 *
 * 这条测试锁住措辞：提示里必须说是「轮次」，并且解释为什么会超过。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../../src');

describe('轮次上限的提示措辞', () => {
  it('提示里说的是「轮次」而不是「步数」', () => {
    const text = readFileSync(resolve(SRC, 'session/loop.ts'), 'utf8');
    assert.match(text, /达到单轮最大轮次/);
    // 不能再说「步数」——会和 metrics.steps（工具调用总数）混淆
    assert.doesNotMatch(text, /达到单轮最大步数/);
  });

  it('提示里解释了为什么工具调用数会高于轮次', () => {
    const text = readFileSync(resolve(SRC, 'session/loop.ts'), 'utf8');
    assert.match(text, /并发/);
    assert.match(text, /工具调用总数/);
  });

  it('提示里给了可执行的下一步（缩小范围）', () => {
    const text = readFileSync(resolve(SRC, 'session/loop.ts'), 'utf8');
    assert.match(text, /缩小范围/);
  });

  it('界面上的步数标签说的是「工具调用」', () => {
    // 本文件在 apps/runtime/src/test/，web 在 apps/web/src/
    const webSrc = resolve(import.meta.dirname, '../../../web/src');

    // 只检查**当前存在**的轨迹视图组件。
    //
    // 原来这里写死了 RunnerLane.tsx，但它后来被删了（那个组件被并进
    // TraceView），测试就读不到文件而失败——**删组件时忘了同步测试**。
    //
    // 现在按"存在才检查"来：只要还有一个视图在显示步数，
    // 它就必须说清单位。
    const candidates = ['components/TraceView.tsx', 'components/RunnerLane.tsx'].filter((f) => {
      try {
        readFileSync(resolve(webSrc, f), 'utf8');
        return true;
      } catch {
        return false;
      }
    });

    assert.ok(candidates.length > 0, '一个轨迹视图组件都没找到');

    for (const f of candidates) {
      const text = readFileSync(resolve(webSrc, f), 'utf8');
      assert.match(text, /工具调用|次工具调用/, `${f} 里的步数标签没说清单位`);
    }
  });
});
