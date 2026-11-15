/**
 * 颜色语义。
 *
 * 核心约束：**琥珀只用于"需要用户操作"**。
 *
 * 之前一个颜色承担 5 种含义（待决定、链接、状态点、警告图标、性能指标），
 * 想表达"这里需要你注意"时已经没有更强的颜色了。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { TONE_VAR, canUseAccent, toneForStatus } from '../components/semanticColor.js';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

describe('状态 → 语义色', () => {
  it('**进行中用琥珀**（需要用户关注）', () => {
    assert.equal(toneForStatus('running'), 'action');
    assert.equal(toneForStatus('starting'), 'action');
  });

  it('排队用中性信息色（不是琥珀）', () => {
    assert.equal(toneForStatus('queued'), 'info');
  });

  it('完成用绿', () => {
    assert.equal(toneForStatus('done'), 'success');
  });

  it('失败用红', () => {
    assert.equal(toneForStatus('failed'), 'danger');
  });

  it('取消用灰（不是红——取消不是错误）', () => {
    assert.equal(toneForStatus('cancelled'), 'muted');
  });

  it('未知状态退回灰，不崩', () => {
    assert.equal(toneForStatus('weird-status'), 'muted');
  });
});

describe('**琥珀不能用于装饰**', () => {
  it('只有 action 类可以用', () => {
    assert.equal(canUseAccent('action'), true);
  });

  it('装饰不行', () => {
    assert.equal(canUseAccent('decoration'), false);
  });

  it('**容器不行**（大面积琥珀会稀释信号）', () => {
    assert.equal(canUseAccent('container'), false);
  });

  it('普通状态不行', () => {
    assert.equal(canUseAccent('status'), false);
  });
});

describe('语义变量齐全', () => {
  it('每个语义都有对应的 CSS 变量', () => {
    for (const [tone, varName] of Object.entries(TONE_VAR)) {
      assert.ok(varName.startsWith('--'), `${tone} 的变量名不对`);
    }
  });

  it('CSS 里定义了这些变量', () => {
    for (const varName of ['--accent', '--ok', '--danger', '--info', '--text-dim']) {
      assert.match(css, new RegExp(`${varName}:`), `CSS 缺少 ${varName}`);
    }
  });
});

describe('**待决策面板不许大面积用琥珀**', () => {
  it('容器背景不是琥珀色混合', () => {
    // 之前是 color-mix(--accent 8%) + border(--accent 45%)，
    // 整块面板泛琥珀，加上内部图标和链接，一屏全是琥珀。
    const m = /\.decision-panel\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '找不到 .decision-panel 规则');
    const body = m[1] ?? '';

    assert.doesNotMatch(body, /background:\s*color-mix/, '容器背景不该用 accent 混合');
    assert.match(body, /background:\s*var\(--bg-panel\)/, '容器应该用普通面板色');
  });

  it('左侧一条细边表示"需要处理"就够了', () => {
    const m = /\.decision-panel\s*\{([^}]*)\}/.exec(css);
    assert.match(m?.[1] ?? '', /border-left:\s*2px solid var\(--accent\)/);
  });
});
