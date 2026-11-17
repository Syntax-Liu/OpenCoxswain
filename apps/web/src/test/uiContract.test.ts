/**
 * 控件契约：**ui/ 之外不许出现裸控件**。
 *
 * ## 为什么需要这条测试
 *
 * 界面里曾有 113 个 `<button>`，其中 84 个没有 `.btn` 类。
 * 它们拿到的是 `styles.css:360` 那条**全局 `button { }` 默认样式**——
 * 看起来"像那么回事"，但尺寸、内边距、悬停色都不是契约值。
 * 这就是用户说的「要么直接用系统默认的按钮设计」。
 *
 * 老办法是写一条测试读 `styles.css`，检查 `.btn` 有没有 5 个变体。
 * 那条测试**永远是绿的**——它只检查"规矩写没写"，不检查"有没有人遵守"。
 * 于是测试一直通过，界面一直漂。
 *
 * 这条测试反过来做：扫全部 TSX，**谁写了裸控件谁红**。
 *
 * ## 例外怎么处理
 *
 * 不给出"注释里写个 ignore 就放过"的逃生口——那会变成下一轮技术债。
 * 真需要例外就把那个控件搬进 `ui/`（例如 `IconButton`），
 * 让例外变成**有名字、有测试、有文档**的组件。
 *
 * 目前 `ui/` 下唯一允许裸控件的地方，是它自己内部那一层
 * （`Button` 渲染的是真正的 `<button>`，这没得绕）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

const SRC = fileURLToDir(new URL('../../src/', import.meta.url));
/** 控件层自身：唯一允许出现裸控件的地方。 */
const UI_DIR = join(SRC, 'ui');

function fileURLToDir(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

/** 递归收集 `.tsx`（跳过 ui/、测试目录）。 */
function collectTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'ui' || name === 'test' || name === 'node_modules') continue;
      collectTsx(full, out);
    } else if (name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 找裸控件。
 *
 * 只认 `<button` / `<input` / `<select` / `<textarea` 后面紧跟空格、`>`
 * 或换行的情况；`<button-group>` 这类自定义标签不会被误判。
 * JSX 注释块（花括号包住的那种）与行注释里的示例不算。
 */
function findRawControls(source: string): Array<{ line: number; tag: string; text: string }> {
  const stripped = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
  const hits: Array<{ line: number; tag: string; text: string }> = [];
  const re = /<(button|input|select|textarea)(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const line = stripped.slice(0, m.index).split('\n').length;
    const snippet = stripped.slice(m.index, m.index + 90).replace(/\s+/g, ' ');
    hits.push({ line, tag: m[1]!, text: snippet });
  }
  return hits;
}

const files = collectTsx(SRC);

describe('**ui/ 之外不许有裸控件**', () => {
  it('至少扫到了源码文件（防止路径写错后测试静默通过）', () => {
    assert.ok(files.length >= 30, `只扫到 ${files.length} 个 tsx，路径可能不对`);
  });

  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join('/');
    it(rel, () => {
      const hits = findRawControls(readFileSync(file, 'utf8'));
      if (hits.length === 0) return;
      const detail = hits
        .map((h) => `  第 ${h.line} 行  <${h.tag}>  ${h.text}`)
        .join('\n');
      assert.fail(
        `${rel} 里有 ${hits.length} 个裸控件。\n` +
          '改用 src/ui/ 里的组件：\n' +
          '  Button / DangerButton / TextButton / IconButton / TextInput / Textarea / Field / Select\n\n' +
          `确实需要新的控件形态 → 先把它加进 src/ui/，不要在业务组件里裸写。\n\n${detail}`,
      );
    });
  }

  it('ui/ 内部的裸控件数量是预期的（新增说明又多了一层包装）', () => {
    // ui/ 里每个组件都只有**一处**真正渲染原生控件的地方。
    // 数量涨了就意味着加了一层新的包装或出口，需要审。
    //
    // 这份清单是**完整**的：ui/ 下任何一个 .tsx 都必须在表里，
    // 漏登记会由下面那条测试抓出来（否则新增组件可以悄悄绕过审查）。
    const expected = {
      'ui/Button.tsx': 1, // renderButton：Button/TextButton/DangerButton 共用
      'ui/IconButton.tsx': 1,
      'ui/Field.tsx': 2, // <input> 与 <textarea>
      'ui/ListItem.tsx': 2, // ListItem 与 MenuItem
      'ui/OptionItem.tsx': 2, // OptionItem 与 SendButton
      'ui/WindowButton.tsx': 1,
      // 纯样式/纯文本组件，不该出现任何原生控件：
      'ui/Text.tsx': 0,
      'ui/index.ts': 0,
    };
    for (const [rel, count] of Object.entries(expected)) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const hits = findRawControls(src);
      assert.equal(
        hits.length,
        count,
        `${rel} 的裸控件数量变了（${hits.length}，预期 ${count}）。` +
          '如果是有意调整，请同步更新这条测试并说明原因。',
      );
    }
  });

  it('**ui/ 下每个文件都登记在上面那张表里**', () => {
    // 没有这条，"新增一个组件就悄悄绕过审查"是可能的：
    // 上面的循环只检查表里有的文件，新文件不在表里 = 完全不被检查。
    const declared = new Set([
      'Button.tsx',
      'IconButton.tsx',
      'Field.tsx',
      'ListItem.tsx',
      'OptionItem.tsx',
      'WindowButton.tsx',
      'Text.tsx',
      'index.ts',
    ]);
    const actual = readdirSync(UI_DIR).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    const missing = actual.filter((f) => !declared.has(f));
    assert.deepEqual(
      missing,
      [],
      '这些 ui/ 下的新文件没有登记裸控件数量，等于不受约束：\n  ' +
        missing.join('\n  ') +
        '\n请在上面的 expected 表里为它登记（纯组件写 0）。',
    );
    // 反过来：表里登记了但文件已删，也要收紧
    const stale = [...declared].filter((f) => !actual.includes(f));
    assert.deepEqual(stale, [], `表里登记的这些文件已不存在：${stale.join(', ')}`);
  });
});

describe('**按钮类名只能由 ui/ 生成**', () => {
  it('业务代码里不许手写 btn 类串', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // 逐个元素检查：凡是 className 里出现 btn-- 的，只对**可交互**元素报错。
      //
      // 为什么不是一刀切：附件 chip 是个 `<div className="btn btn--secondary …">`，
      // 它是"借用按钮外观的非交互元素"（不响应点击，只显示）。这类借用 CSS
      // 是合理的，硬改成 <Button> 反而会得到一个能点、但没有行为的按钮。
      const interactive = [...src.matchAll(/<(button|a)\b[^>]*className=\{?["'`][^"'`]*\bbtn--/g)];
      if (interactive.length > 0) {
        offenders.push(`${relative(SRC, file).split(sep).join('/')}（${interactive.length} 处可交互元素）`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '这些文件在可交互元素上手写了 .btn 类串，应改用 src/ui 的按钮组件：\n  ' + offenders.join('\n  '),
    );
  });

  it('非交互元素借用按钮外观的地方要有记录', () => {
    // 借外观 = className 里有 btn-- 但不是 button/a 标签。
    // 目前只有附件 chip 一处。数量涨了说明有人在绕路，需要审。
    const borrowing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const all = [...src.matchAll(/className=\{?["'`][^"'`]*\bbtn--[^"'`]*["'`]?/g)];
      const interactiveCount = [...src.matchAll(/<(button|a)\b[^>]*className=\{?["'`][^"'`]*\bbtn--/g)]
        .length;
      if (all.length > interactiveCount) {
        borrowing.push(relative(SRC, file).split(sep).join('/'));
      }
    }
    assert.deepEqual(
      borrowing,
      ['components/AttachmentStrip.tsx'],
      '借用按钮外观的非交互元素清单变了。新增请说明理由，并同步更新这条测试。',
    );
  });
});
