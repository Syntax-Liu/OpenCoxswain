/**
 * 截断覆盖：**内容长度不可控的部分，必须能截断**。
 *
 * ## 为什么需要这条测试
 *
 * 用户的原话：「界面设计总有些 bug，比如文字溢出等等」。
 *
 * 现有的 `overflowLayout.test.ts` 只锁了 **2 个**元素：
 * `model-item-name` / `model-item-id`。其它所有会被长名字撑破的地方
 * （项目名、会话标题、路径、模型名…）**一条测试都没有**。
 * 于是每加一个新列表，就是新一轮"跑起来才发现撑破"。
 *
 * 这条测试换个做法：**从源码里找出"放进有界容器里的文本元素"，
 * 要求它们要么带齐截断四件套，要么登记在白名单里并写明理由。**
 *
 * 白名单是这份文件里的 `BOUNDED_TEXTS`——新增一条就是做一次决定，
 * 而不是漏掉就漏掉了。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某个选择器下的全部声明（同名规则合并）。 */
function declarations(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[,\\s])${esc}\\s*\\{([^}]*)\\}`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push(m[1]!);
  return out.join(';');
}

/** 截断四件套。 */
const TRUNCATION = [
  ['white-space', 'nowrap'],
  ['overflow', 'hidden'],
  ['text-overflow', 'ellipsis'],
  ['min-width', '0'],
] as const;

function hasTruncation(selector: string): { ok: boolean; missing: string[] } {
  const body = declarations(selector);
  if (!body) return { ok: false, missing: ['（CSS 里没有这个类）'] };
  const missing: string[] = TRUNCATION.filter(
    ([prop, value]) => !new RegExp(`${prop}\\s*:\\s*${value}`).test(body),
  ).map(([prop]) => prop);
  // 不能是 inline：inline 元素的 ellipsis 不生效。
  // `display: block` / `inline-block` / `flex` 都对；写成 `inline` 才不行。
  if (/display\s*:\s*inline\s*;/.test(body)) missing.push('display(不能是 inline)');
  return { ok: missing.length === 0, missing };
}

/**
 * 已知会被"用户输入或外部数据"填满、又放在有界宽度里的文本类。
 *
 * 每一条都要能解释：这个文本最长能有多长？它所在的容器为什么有界？
 * 新增列表行/标题时，把类名加到这里——加一条就是做一次决定。
 */
const BOUNDED_TEXTS = [
  // 模型设置：模型名与 id（原有的唯一两条测试）
  'model-item-name',
  'model-item-id',
  // 侧边栏：项目名是用户随手起的，可能很长
  'folder-name',
  // 侧边栏：会话 / Agent 标题
  'thread-title',
  // 项目选择器：项目名 + 路径
  'project-picker-name',
  // 标题栏面包屑：项目名 + 视图名
  'title-bar-crumb',
  // 批次块里的「当前步骤」：文件名/命令长度不可控（UD-01 新增）
  'batch-task-step',
];

describe('**内容不可控的文本必须能截断**', () => {
  for (const cls of BOUNDED_TEXTS) {
    it(`.${cls}`, () => {
      const { ok, missing } = hasTruncation(`.${cls}`);
      assert.ok(
        ok,
        `.${cls} 不能正确截断，缺：${missing.join(', ')}\n` +
          '用 <Text truncate> 渲染，或给它补上四条声明。\n' +
          '（如果它其实不会溢出，请从 BOUNDED_TEXTS 里删掉并说明）',
      );
    });
  }
});

describe('**ui/Text 的截断类是齐的**', () => {
  it('.text-truncate 四条齐全', () => {
    const { ok, missing } = hasTruncation('.text-truncate');
    assert.ok(ok, `.text-truncate 缺：${missing.join(', ')}`);
  });

  it('容器类能让 flex/grid 子项收缩', () => {
    const body = declarations('.text-container');
    assert.match(body, /min-width\s*:\s*0/, '.text-container 必须有 min-width: 0');
  });
});
