/**
 * CSS 结构健康：防止重复规则和无用代码重新长回来。
 *
 * ## 背景
 *
 * `styles.css` 是单文件，历史上同一个类被反复追加定义。
 * 2026-11-17 清理过一轮，这份测试负责让清理结果**不退回**。
 *
 * 清掉的东西：
 *
 * - **9 个空规则块**（`.md-body p { }` 之类）——不产生任何样式，
 *   却让人以为"这里定义了点什么"，排查时白白浪费时间
 * - **同一基础选择器被定义 4~5 次**（`.thread-item` / `.sidebar` /
 *   `.messages` / `.composer` / `.composer-box` / `.project-folder` /
 *   `.workspace-head`）——属性分散在不同位置，靠"后定义覆盖前定义"
 *   才能得到最终效果，谁都不敢改
 *
 * ## 为什么用"上限"而不是"等于 N"
 *
 * 不是要求每个选择器只出现一次。`:hover`、`.active`、媒体查询里的
 * 覆盖都是正当的重复。这里只拦住**失控增长**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
/** 去掉注释，避免注释里的示例代码干扰。 */
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('**不许有空规则块**', () => {
  it('没有 `选择器 { }` 这种只有空白的规则', () => {
    const empty = [];
    for (const m of clean.matchAll(/([^{}]+)\{\s*\}/g)) {
      const selector = (m[1] ?? '').trim().split('\n').pop()?.trim() ?? '';
      if (!selector || selector.startsWith('@')) continue;
      empty.push(selector);
    }
    assert.deepEqual(empty, [], '这些规则块是空的，删掉：\n  ' + empty.join('\n  '));
  });
});

describe('**基础选择器不许重复定义超过 2 次**', () => {
  /**
   * 上限 2：允许一条基础定义 + 一条补充（例如媒体查询或明确的分阶段定义）。
   * 超过 2 次说明又在"往后追加"了，应该合并进第一条。
   */
  const LIMIT = 2;

  const BASE_SELECTORS = [
    '.thread-item',
    '.sidebar',
    '.messages',
    '.composer',
    '.composer-box',
    '.project-folder',
    '.workspace-head',
    '.status-bar',
    '.conversation-header',
  ];

  for (const selector of BASE_SELECTORS) {
    it(`${selector} 的定义不超过 ${LIMIT} 次`, () => {
      // 只数"选择器单独一行且以 { 结尾"的基础规则，
      // 不含 :hover / .active / 逗号组里的引用
      const re = new RegExp(`^${selector.replace(/\./g, '\\.')}\\s*\\{`, 'gm');
      const count = [...clean.matchAll(re)].length;
      assert.ok(
        count <= LIMIT,
        `${selector} 被定义了 ${count} 次（上限 ${LIMIT}）。` +
          `分散定义会让"后定义覆盖前定义"，把属性合并进主规则。`,
      );
    });
  }
});

describe('**`.md-body` 的规则块数量**', () => {
  it('不超过 25 块（清理后是 23）', () => {
    // 每一块应该服务不同的元素（table/th/code/pre/p/li/h1-h4…），
    // 不是同一个元素被反复定义。历史上是 27 块且含 2 个空块。
    const blocks = [...clean.matchAll(/^\.md-body[^{]*\{/gm)].length;
    assert.ok(blocks <= 25, `.md-body 规则块 ${blocks} 个，超过上限——检查是否又在追加重复定义`);
  });

  it('段落间距规则里**必须同时包含 .bubble p**', () => {
    // 纯文本消息没有 .md-body 包裹（父链是 div.bubble）。
    // 只写 .md-body p 的话，16px 间距对纯文本消息完全不生效。
    assert.match(
      clean,
      /\.md-body p,\s*\.bubble p\s*\{[^}]*margin:\s*0 0 var\(--g-4\)/,
      '段落间距必须同时作用于 .md-body p 与 .bubble p',
    );
  });
});

describe('**样式文件规模**', () => {
  /**
   * 上限 **7200 行**（2026-11-17 从 7000 上调）。
   *
   * ## 为什么上调
   *
   * 控件层重做（Button → ListItem → Field → OptionItem）每一轮都是
   * "追加一段带说明的规格块到文件末尾"，共 +349 行。
   *
   * 追加而不是就地合并，是为了**避开前 6500 行的 CRLF 混排区**
   * （见 ui-dev-guide 7.2）——那里整块重写会产生几百行假 diff。
   *
   * ## 但这不是长久之计
   *
   * 文件该拆了。等控件层全部做完，应该把末尾这些规格块提到
   * `ui.css` 单独维护，`styles.css` 只留历史遗留部分。
   * 在那之前，这条测试只防止**不受控的增长**。
   */
  it('不超过 7200 行', () => {
    const lines = css.split('\n').length;
    assert.ok(
      lines <= 7200,
      `styles.css 已 ${lines} 行。控件层规格块该单独拆成 ui.css 了。`,
    );
  });
});
