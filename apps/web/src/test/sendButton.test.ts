/**
 * 发送按钮：必须是正圆，且三个页面一致。
 *
 * ## 为什么需要这条测试
 *
 * 之前组件写的是 `btn btn--primary btn--md btn--pill send-btn`：
 * `.btn--md` 给 26px 高 + 12px 左右内边距 → 宽约 40px，
 * 百分号圆角画在 40×26 上是**椭圆**；而 `.send-btn` 这个类
 * **CSS 里根本不存在**——没有任何测试会发现"类名引用了但没有定义"。
 *
 * 更糟的是三个页面三种长相：
 *   主对话     图标按钮
 *   新会话     文字 `↑`
 *   Supervisor 文字「帮我找」
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (p: string): string => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

const cssNoComment = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

interface Page {
  readonly name: string;
  readonly src: string;
}

const PAGES: readonly Page[] = [
  { name: '主对话', src: read('components/Conversation.tsx') },
  { name: '新会话', src: read('components/NewSession.tsx') },
  { name: 'Supervisor', src: read('components/GlobalAssistant.tsx') },
];

/** 取某条 CSS 规则体；找不到返回 null。 */
function rule(selector: string): string | null {
  const escaped = selector.replace('.', '\\.');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(cssNoComment);
  return m ? (m[1] ?? null) : null;
}

describe('**发送按钮是正圆**', () => {
  it('.send-btn 定义了宽高相等', () => {
    const body = rule('.send-btn');
    assert.ok(body, 'CSS 里没有 .send-btn —— 类名引用了却没有定义');
    assert.match(body, /width:\s*34px/);
    assert.match(body, /height:\s*34px/);
  });

  it('**没有横向内边距**（否则宽高不等就不圆了）', () => {
    const body = rule('.send-btn') ?? '';
    assert.match(body, /padding:\s*0\s*;/);
  });

  it('圆角用 --r-full', () => {
    const body = rule('.send-btn') ?? '';
    assert.match(body, /border-radius:\s*var\(--r-full\)/);
  });

  it('**不套通用 btn 尺寸类**', () => {
    for (const page of PAGES) {
      const uses = [...page.src.matchAll(/className="([^"]*send-btn[^"]*)"/g)].map(
        (m) => m[1] ?? '',
      );
      for (const cls of uses) {
        assert.doesNotMatch(
          cls,
          /\bbtn--(md|sm|lg|pill)\b/,
          `${page.name} 的发送按钮还在套通用尺寸类: ${cls}`,
        );
      }
    }
  });
});

describe('**三个页面的发送按钮一致**', () => {
  it('都用 ui/SendButton（它内部渲染 .send-btn）', () => {
    for (const page of PAGES) {
      assert.match(page.src, /<SendButton\b/, `${page.name} 没用 ui/SendButton`);
    }
  });

  it('**都用 IconSend 图标**，不是文字箭头', () => {
    for (const page of PAGES) {
      assert.match(page.src, /<IconSend\b/, `${page.name} 没用 IconSend`);
    }
  });

  it('**「帮我找」已经删掉**', () => {
    // 允许出现在注释里（说明为什么改），但不能是按钮文字
    const active = (PAGES[2]?.src ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    assert.doesNotMatch(active, /帮我找/, 'Supervisor 还在用「帮我找」文字按钮');
  });

  it('都有可读名字（SendButton 默认「发送」）', () => {
    // 迁移到 ui/SendButton：aria-label 由组件统一给默认值 "发送"，
    // 调用方不必也不能漏写。这里守「用的是 SendButton」这一层即可。
    for (const page of PAGES) {
      assert.match(page.src, /<SendButton\b/, `${page.name} 没用 SendButton`);
    }
    const uiSrc = readFileSync(new URL('../../src/ui/OptionItem.tsx', import.meta.url), 'utf8');
    assert.match(uiSrc, /label = '发送'/, 'SendButton 应该有默认 label "发送"');
  });
});

describe('禁用态能看清', () => {
  it('**有描边**，不只靠底色', () => {
    const body = rule('.send-btn:disabled') ?? '';
    assert.ok(body, '没有 :disabled 规则');
    assert.match(body, /border:\s*0\.5px solid/, '禁用态没有描边，会和输入框背景糊在一起');
  });
});
