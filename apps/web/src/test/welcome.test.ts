import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const conv = await readFile(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');
const sup = await readFile(new URL('../../src/components/GlobalAssistant.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../../src/styles.css', import.meta.url), 'utf8');

describe('**空会话是欢迎页，不是提示卡**', () => {
  it('主对话用 .welcome', () => {
    assert.match(conv, /className="welcome"/);
    assert.doesNotMatch(conv, /className="hint-card"/, '不该再用 hint-card');
  });

  it('Supervisor 也用 .welcome', () => {
    assert.match(sup, /className="welcome"/);
    assert.doesNotMatch(sup, /className="hint-card"/, '不该再用 hint-card');
  });

  it('欢迎页有居中的大标题', () => {
    assert.match(css, /\.welcome\s*\{[^}]*align-items:\s*center/);
    /**
     * 标题要**明显大于正文**（--fs-lg 是 17px 档），但不写死具体实现。
     *
     * 原来这里断言 `font-size: 24px` 字面量——那把"必须用数字"也变成了
     * 规矩，改成 `calc(24px * var(--font-scale))` 就红。
     * 字号的真正要求是"大"，不是"写 24"。
     */
    const m = /\.welcome-brand h1\s*\{[^}]*font-size:\s*([^;]+);/.exec(css);
    assert.ok(m, '找不到 .welcome-brand h1 的 font-size');
    const value = (m[1] ?? '').trim();
    // 接受两种写法：24px 字面量，或 calc(24px * var(--font-scale))
    assert.match(
      value,
      /^(24px|calc\(\s*24px\s*\*\s*var\(--font-scale\)\s*\))$/,
      `品牌标题应约为 24px，实际是 ${value}`,
    );
  });
});

describe('**三个页面的输入框结构一致**', () => {
  // 踩过两次：
  //   1. Agent 页少了 .composer-box → 裸线
  //   2. Supervisor 页也是
  // 三处必须都是 .composer > .composer-box > (textarea + .composer-bar)
  const pages = [
    ['主对话', conv],
    ['Supervisor', sup],
  ] as const;

  for (const [name, src] of pages) {
    it(`${name} 有 composer-box`, () => {
      assert.match(src, /className="composer-box"/, `${name} 缺少 composer-box`);
    });

    it(`${name} 有 composer-bar`, () => {
      assert.match(src, /className="composer-bar"/, `${name} 缺少 composer-bar`);
    });

    it(`${name} 不再用旧的 composer-actions`, () => {
      assert.doesNotMatch(src, /className="composer-actions"/, `${name} 还在用旧布局`);
    });
  }
});

describe('欢迎页样式', () => {
  it('示例是胶囊按钮', () => {
    const m = /\.welcome-example\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '找不到 .welcome-example');
    assert.match(m[1] ?? '', /border-radius:\s*var\(--r-full\)/);
  });

  it('项目名胶囊用同一套规格', () => {
    assert.match(css, /\.welcome-example-pill/);
  });
});
