/**
 * 精确编辑（edit_file）测试。
 *
 * 这个工具是 P0 缺口之一：没有它，模型改一行要重写整个文件——
 * 烧 token、容易顺手改错别处、大文件根本做不到。
 *
 * 这组测试守的是**真实会踩的坑**，不是理想路径。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyEdit } from '../executor/edit.js';

/** 断言成功并取出内容。 */
function ok(result: ReturnType<typeof applyEdit>): string {
  assert.equal(result.ok, true, result.ok ? '' : `预期成功，实际失败：${result.error}`);
  return (result as { content: string }).content;
}

describe('基本替换', () => {
  it('替换唯一的一段', () => {
    const out = ok(applyEdit('const a = 1;\nconst b = 2;', 'const a = 1;', 'const a = 10;', false));
    assert.equal(out, 'const a = 10;\nconst b = 2;');
  });

  it('删除一段（new_text 为空）', () => {
    const out = ok(applyEdit('keep\nremove\nkeep2', 'remove\n', '', false));
    assert.equal(out, 'keep\nkeep2');
  });

  it('替换成多行', () => {
    const out = ok(applyEdit('a\nb', 'b', 'x\ny\nz', false));
    assert.equal(out, 'a\nx\ny\nz');
  });
});

describe('找不到原文', () => {
  it('**明确报错，不静默写入**', () => {
    const r = applyEdit('const a = 1;', 'const a = 2;', 'x', false);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /没找到/);
  });

  it('错误里给出排查建议', () => {
    const r = applyEdit('abc', 'xyz', 'q', false);
    assert.match((r as { error: string }).error, /read_file/);
  });

  it('空 old_text 被拒绝', () => {
    const r = applyEdit('abc', '', 'x', false);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /不能为空/);
  });

  it('新旧文本相同时拒绝（这次编辑没有意义）', () => {
    const r = applyEdit('abc', 'abc', 'abc', false);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /不会改变/);
  });
});

describe('出现多处', () => {
  const content = 'foo();\nbar();\nfoo();';

  it('**默认拒绝，避免改错地方**', () => {
    const r = applyEdit(content, 'foo();', 'baz();', false);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /出现了 2 次/);
  });

  it('错误里教用户怎么办', () => {
    const r = applyEdit(content, 'foo();', 'baz();', false);
    assert.match((r as { error: string }).error, /更长/);
  });

  it('replace_all 时全部替换', () => {
    const out = ok(applyEdit(content, 'foo();', 'baz();', true));
    assert.equal(out, 'baz();\nbar();\nbaz();');
  });
});

describe('缩进容忍（模型常写错缩进）', () => {
  const content = 'function f() {\n  const a = 1;\n  return a;\n}';

  it('**原文有缩进、模型漏写也能匹配**', () => {
    const out = ok(applyEdit(content, 'const a = 1;', 'const a = 2;', false));
    assert.equal(out, 'function f() {\n  const a = 2;\n  return a;\n}');
  });

  it('模糊匹配时自动补回缩进', () => {
    // 替换内容本身没有缩进，应当被套上原文的两格缩进
    const out = ok(applyEdit(content, 'return a;', 'return a * 2;', false));
    assert.match(out, /\n {2}return a \* 2;/);
  });
});

describe('换行符保持', () => {
  it('**CRLF 文件改完还是 CRLF**', () => {
    const crlf = 'a\r\nb\r\nc';
    const out = ok(applyEdit(crlf, 'b', 'B', false));
    assert.equal(out, 'a\r\nB\r\nc');
    assert.ok(!/[^\r]\n/.test(out), '不该出现孤立的 LF');
  });

  it('LF 文件保持 LF', () => {
    const out = ok(applyEdit('a\nb', 'b', 'B', false));
    assert.equal(out, 'a\nB');
  });

  it('模型传 CRLF 的 old_text 也能匹配 LF 文件', () => {
    const out = ok(applyEdit('a\nb\nc', 'b\r\n', 'B\n', false));
    assert.equal(out, 'a\nB\nc');
  });
});

describe('编辑结果说明', () => {
  it('多处替换时说明替换了几处', () => {
    const r = applyEdit('x\nx\nx', 'x', 'y', true);
    assert.equal(r.ok, true);
    assert.match((r as { summary: string }).summary, /3 处/);
  });

  it('模糊匹配时说明用了缩进匹配', () => {
    // 原文是「两格缩进 + 换行 + 四格缩进」，模型写成顶格两行：
    // 精确匹配找不到，只能走忽略缩进的模糊路径
    const src = 'function f() {\n    const a = 1;\n    return a;\n}';
    const r = applyEdit(src, 'const a = 1;\nreturn a;', 'const a = 2;\nreturn a;', false);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    assert.match((r as { summary: string }).summary, /模糊匹配/);
  });
});

describe('边界情况', () => {
  it('替换文件开头', () => {
    const out = ok(applyEdit('first\nsecond', 'first', 'FIRST', false));
    assert.equal(out, 'FIRST\nsecond');
  });

  it('替换文件结尾', () => {
    const out = ok(applyEdit('first\nlast', 'last', 'LAST', false));
    assert.equal(out, 'first\nLAST');
  });

  it('中文内容', () => {
    const out = ok(applyEdit('// 旧注释\ncode', '// 旧注释', '// 新注释', false));
    assert.equal(out, '// 新注释\ncode');
  });

  it('多行块替换', () => {
    const src = 'start\nA\nB\nend';
    const out = ok(applyEdit(src, 'A\nB', 'X\nY\nZ', false));
    assert.equal(out, 'start\nX\nY\nZ\nend');
  });

  it('替换后内容为空文件', () => {
    const out = ok(applyEdit('only', 'only', '', false));
    assert.equal(out, '');
  });
});
