/**
 * 长文本不该撑破容器。
 *
 * ## 为什么需要这条测试
 *
 * 用户截图里「DeepSeek-Flash」撑破了模型列表项的边框。
 *
 * 这类问题**跑起来才暴露**——写代码时看着没问题，
 * 只有填进一个长名字才看出来。而且一旦漏掉，
 * 用户看到的是"界面坏了"，不是"某个字太长"。
 *
 * ## 关键点
 *
 * 光加 `text-overflow: ellipsis` **不够**：
 *   - 没有 `overflow: hidden` → ellipsis 不生效
 *   - 没有 `white-space: nowrap` → 它换行了，也就没有省略号
 *   - 没有 `min-width: 0` → flex 子项默认 min-width:auto，根本不会被压缩
 *
 * 四条缺一不可。测试就锁这四条。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? (m[1] ?? '') : '';
}

/** 内容长度不可控、又放在有界宽度里的文本元素。 */
const TRUNCATED = ['model-item-name', 'model-item-id'];

/** 容器本身也要能收缩，否则子元素的 min-width:0 没用。 */
const CONTAINERS = ['model-list', 'model-item'];

describe('**显示长名字的元素要能截断**', () => {
  for (const cls of TRUNCATED) {
    describe(`.${cls}`, () => {
      const body = rule(`.${cls}`);

      it('存在这条规则', () => {
        assert.ok(body, `CSS 里没有 .${cls}`);
      });

      it('有 overflow: hidden（ellipsis 的前提）', () => {
        assert.match(body, /overflow:\s*hidden/, `${cls} 缺 overflow:hidden，省略号不会出现`);
      });

      it('有 text-overflow: ellipsis', () => {
        assert.match(body, /text-overflow:\s*ellipsis/);
      });

      it('有 white-space: nowrap（否则是换行而不是省略）', () => {
        assert.match(body, /white-space:\s*nowrap/);
      });

      it('有 min-width: 0（flex 子项默认 auto，不会收缩）', () => {
        assert.match(body, /min-width:\s*0/);
      });
    });
  }
});

describe('**容器也要能收缩**', () => {
  for (const cls of CONTAINERS) {
    it(`.${cls} 有 min-width: 0`, () => {
      const body = rule(`.${cls}`);
      assert.ok(body, `CSS 里没有 .${cls}`);
      assert.match(
        body,
        /min-width:\s*0/,
        `${cls} 缺 min-width:0 —— 内容超宽会把它撑破`,
      );
    });
  }
});

describe('设置页不盖住窗口按钮', () => {
  it('.settings-overlay 给标题栏让出顶部空间', () => {
    const body = rule('.settings-overlay');
    assert.ok(body, 'CSS 里没有 .settings-overlay');
    // inset:0 会把 30px 高的自绘标题栏一起盖住
    assert.match(
      body,
      /top:\s*30px/,
      '.settings-overlay 用了 inset:0 或没设 top，会把最小化/最大化/关闭盖住',
    );
  });
});

describe('**多行按钮要覆盖全局 button 规则**', () => {
  // 全局有 `button { height: var(--h-md) /* 26px */; align-items: center }`，
  // 那是给"一行文字"的普通按钮用的。
  //
  // 多行按钮（图标+文字、名字+id）套上之后会被压成 26px，
  // 里面的每一行都糊成一团——用户截图里的模型项就是这样。
  //
  // 这些类都是 `display:flex; flex-direction:column` 的 <button>，
  // 必须显式覆盖 height 和 align-items。
  const MULTILINE_BUTTONS = ['model-item', 'icon-theme-option', 'onboarding-card', 'template-card'];

  for (const cls of MULTILINE_BUTTONS) {
    describe(`.${cls}`, () => {
      const body = rule(`.${cls}`);

      it('是列方向的 flex（确认它确实是多行按钮）', () => {
        assert.ok(body, `CSS 里没有 .${cls}`);
        assert.match(body, /flex-direction:\s*column/, `${cls} 不是列方向 flex`);
      });

      it('**覆盖了全局的固定高度**', () => {
        assert.match(
          body,
          /(?:^|[\s;])height:\s*auto/,
          `${cls} 没覆盖 height —— 会被全局 button 的 26px 压扁`,
        );
      });

      it('**覆盖了全局的 align-items: center**', () => {
        assert.match(
          body,
          /align-items:\s*stretch/,
          `${cls} 没覆盖 align-items —— 子元素会被居中压缩`,
        );
      });
    });
  }
});
