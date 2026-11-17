/**
 * 主题三件套：**每个颜色变量在两套主题下都必须有定义**。
 *
 * ## 为什么需要这条测试
 *
 * `styles.css` 的令牌是两层的：原始色板 `--c-*` 只写十六进制，
 * 语义层 `--color-*` 引用它。切主题时只覆盖原始色板
 * （`<html data-theme="light">` 下重定义 `--c-*`）。
 *
 * 这个机制成立的前提是：**每个 `--c-*` 在亮色主题里也有一份**。
 * 一旦漏了，`var(--c-xxx)` 在亮色下就解析成空值——
 * 于是背景变透明、文字变黑、边框消失。
 * 这正是历史上出现过的"亮色主题下变成灰斑"那个 bug 的成因。
 *
 * 而 `audit-live-contrast` 之类靠**截图**的检查不一定抓得住
 * （透明的背景会被算成父级背景，看起来"对比度还行"）。
 * 所以这条用静态检查兜底。
 *
 * > 注意：语义层 `--color-*` **不需要**在两套主题里重复定义——
 * > 它只做 `var(--c-*)` 映射，色板一换它就跟着换了。
 * > 只有原始层需要重复。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 从指定块里抽出变量名 → 值。 */
function varsIn(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1]!.trim(), m[2]!.trim());
  }
  return out;
}

/** 取 `:root { ... }`（第一个颜色板的块）。 */
function blockFor(selectorPattern: RegExp): string {
  const m = selectorPattern.exec(css);
  assert.ok(m, `找不到规则：${selectorPattern}`);
  // 从匹配到的 `{` 开始做花括号配对
  const start = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error('花括号不配对');
}

const darkRaw = varsIn(blockFor(/^:root\s*\{/m));
const lightBlockMatch = /\[data-theme='light'\]\s*\{/.exec(css);
assert.ok(lightBlockMatch, 'CSS 里没有 [data-theme=\'light\'] 色板');

function lightRawVars(): Map<string, string> {
  const start = css.indexOf('{', lightBlockMatch!.index);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return varsIn(css.slice(start + 1, i));
    }
  }
  throw new Error('亮色块花括号不配对');
}

const lightRaw = lightRawVars();

/** 只关心色板层：`--c-*`。 */
const rawNames = [...darkRaw.keys()].filter((k) => k.startsWith('--c-'));

/**
 * **有意不随主题变的原始色**。
 *
 * 这三条都是"压在彩色块上的白字"，两套主题下**应该**是同一个值：
 * 主按钮（琥珀底）上的文字、关闭键悬停（红底）上的叉，
 * 前后景关系由底色保证，不随主题翻转。
 *
 * 加进来要写清理由——这是唯一的例外通道。
 */
const THEME_INVARIANT = new Map([
  ['--c-on-accent', '主色块上的文字：色块本身两套主题都有各自的饱和度，文字保持白'],
  ['--c-on-accent-light', '亮色下压暗的琥珀底上的文字，同样是白'],
  ['--c-window-close', '关闭键悬停红：Windows 标准色，不随应用主题变'],
]);

describe('**色板层在两套主题下都齐全**', () => {
  it('扫到了足够多的原始色', () => {
    assert.ok(rawNames.length >= 20, `只扫到 ${rawNames.length} 个 --c-* 色，解析可能不对`);
  });

  it('亮色主题覆盖了每一个原始色（缺一个 = 亮色下变透明）', () => {
    const missing = rawNames.filter(
      (name) => !lightRaw.has(name) && !THEME_INVARIANT.has(name),
    );
    assert.deepEqual(
      missing,
      [],
      '这些原始色在 [data-theme=\'light\'] 里没有定义，亮色主题下会解析成空值：\n  ' +
        missing.join('\n  ') +
        '\n\n确实是有意不随主题变的，请加进 THEME_INVARIANT 并写明理由。',
    );
  });

  it('例外表里的变量确实存在（防止删了变量还留着例外）', () => {
    for (const name of THEME_INVARIANT.keys()) {
      assert.ok(darkRaw.has(name), `例外表里的 ${name} 在暗色色板里已经不存在了`);
    }
  });

  it('亮色主题不该凭空多出暗色没有的原始色', () => {
    const extra = [...lightRaw.keys()].filter((k) => k.startsWith('--c-') && !darkRaw.has(k));
    assert.deepEqual(
      extra,
      [],
      '这些原始色只在亮色主题里有，暗色下引用它们同样会变空值：\n  ' + extra.join('\n  '),
    );
  });

  it('色板层只用 var() 或有效色值，不写裸十六进制（十六进制只在原始层）', () => {
    // 原始层允许十六进制；这条反过来检查语义层没有漏网的十六进制
    const semantic = [...darkRaw.entries()].filter(([k]) => k.startsWith('--color-'));
    const offenders = semantic
      .filter(([, v]) => /#[0-9a-f]{3,8}\b/i.test(v) || /rgba?\(/.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    assert.deepEqual(
      offenders,
      [],
      '语义层应当只引用原始层（var(--c-*)），不直接写色值：\n  ' + offenders.join('\n  '),
    );
  });
});
