/**
 * 动效契约（UD-09）+ 减少动效覆盖（UD-07）。
 *
 * ## 为什么需要
 *
 * `ui-dev-guide.md` §3.6 定了规则：
 *
 * > 状态变化用 `--dur-fast`，元素出现用 `--dur-base`，面板滑入用 `--dur-slow`。
 *
 * 但**没有测试守**。下一个人写 `transition: 0.15s ease` 就悄悄漂了，
 * 和当初 `.md-body` 被覆盖 27 次是同一类问题——规矩写下来了，没人执行。
 *
 * ## 减少动效为什么要测
 *
 * 2026-11-17 查下来：5 种动画只有 2 种处理了 `prefers-reduced-motion`。
 * 缺的三个（`.typing i` / `.waiting-dots i` / `.notice-card`）
 * 恰恰都是「Agent 工作时一直转」的，最影响用户。
 *
 * WCAG 2.3.3 要求动画可被用户关掉。这条测试守住"以后加动画别忘"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
/** 去掉注释，避免注释里的示例文字干扰断言。 */
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出所有 `@media (prefers-reduced-motion: reduce) { ... }` 块的内容。 */
function reducedMotionBlocks(): string[] {
  const blocks: string[] = [];
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    // 从 { 开始做花括号配对
    let depth = 0;
    const start = clean.indexOf('{', m.index);
    for (let i = start; i < clean.length; i += 1) {
      if (clean[i] === '{') depth += 1;
      else if (clean[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(clean.slice(start + 1, i));
          break;
        }
      }
    }
  }
  return blocks;
}

const reduced = reducedMotionBlocks().join('\n');

describe('**过渡时长只许用令牌**', () => {
  it('三个时长令牌都存在', () => {
    for (const token of ['--dur-fast', '--dur-base', '--dur-slow']) {
      assert.match(clean, new RegExp(`${token}:\\s*[\\d.]+m?s`), `缺少 ${token}`);
    }
  });

  it('transition 里没有写死的秒数', () => {
    // 只检查**正常运行**时的 transition。
    // 减少动效块里的 `0.01ms !important` 是兜底值，不是过渡定义，必须排除。
    let normal = clean;
    for (const block of reducedMotionBlocks()) {
      normal = normal.replace(block, '');
    }

    const offenders: string[] = [];
    for (const m of normal.matchAll(/transition[^:]*:\s*([^;]+);/g)) {
      const value = m[1] ?? '';
      const withoutVars = value.replace(/var\([^)]*\)/g, '');
      if (/\b\d*\.?\d+m?s\b/.test(withoutVars)) {
        offenders.push(value.trim());
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些 transition 写了裸时长，应改用 --dur-fast / --dur-base / --dur-slow：\n  ' +
        offenders.join('\n  '),
    );
  });

  it('没有用 linear 缓动', () => {
    const offenders = [...clean.matchAll(/transition[^:]*:\s*([^;]+);/g)]
      .map((m) => m[1] ?? '')
      .filter((v) => /\blinear\b/.test(v));
    assert.deepEqual(offenders, [], '过渡不该用 linear：\n  ' + offenders.join('\n  '));
  });
});

describe('**减少动效覆盖所有动画**', () => {
  it('存在减少动效块', () => {
    assert.ok(reduced.length > 0, 'CSS 里没有 prefers-reduced-motion 块');
  });

  it('**有全局兜底**（以后新增动画自动被收住）', () => {
    assert.match(
      reduced,
      /animation-iteration-count:\s*1\s*!important/,
      '缺少全局兜底：新增动画会不受减少动效约束',
    );
    assert.match(reduced, /animation-duration:\s*0\.01ms/);
  });

  const ANIMATED = ['.typing i', '.batch-dot.running', '.waiting-dots i', '.notice-card', '.stream-cursor'];

  for (const selector of ANIMATED) {
    it(`${selector} 在减少动效下不循环`, () => {
      // 有单独处理，或被全局兜底覆盖
      const ownHandling = reduced.includes(selector);
      const globalBackstop = /animation-iteration-count:\s*1\s*!important/.test(reduced);
      assert.ok(
        ownHandling || globalBackstop,
        `${selector} 有动画但没处理减少动效`,
      );
    });
  }

  it('已有两处的既有写法没被推翻（opacity 1 / 0.6 是有意选的）', () => {
    assert.match(reduced, /\.batch-dot\.running\s*\{[^}]*opacity:\s*1/);
    assert.match(reduced, /\.stream-cursor\s*\{[^}]*opacity:\s*0\.6/);
  });

  it('打字指示点用停动画而不是隐藏（信息不该丢）', () => {
    const block = reduced.slice(reduced.indexOf('.typing i'));
    assert.match(block.slice(0, 200), /animation:\s*none/);
    assert.doesNotMatch(block.slice(0, 200), /display:\s*none/, '不能隐藏，只停动画');
  });
});

describe('**全局兜底只在媒体查询内**', () => {
  it('`*` 的 !important 规则没有跑到媒体查询外面', () => {
    // 去掉所有减少动效块后，不该再有 `animation-iteration-count: 1 !important`
    let outside = clean;
    for (const block of reducedMotionBlocks()) {
      outside = outside.replace(block, '');
    }
    assert.doesNotMatch(
      outside,
      /animation-iteration-count:\s*1\s*!important/,
      '全局兜底漏到了媒体查询外，会影响正常模式',
    );
  });
});
