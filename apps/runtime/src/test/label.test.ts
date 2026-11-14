/**
 * 侧栏标签清理。
 *
 * 核心约束：**清理后不成句就保留原文**。
 *
 * 第一版试过正则硬删工具名和文件名，结果清出"根目录""写 为"这种残句，
 * 比原文更难懂。现在改成"识别 + 不成句就回退"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { displayLabel, hasImplementationDetail } from '../orchestrator/label.js';

describe('识别实现细节', () => {
  it('含工具名就算', () => {
    assert.equal(hasImplementationDetail('用 write_file 把 a.txt 改成 b'), true);
  });

  it('含文件扩展名就算', () => {
    assert.equal(hasImplementationDetail('统计根目录 .txt 数量'), true);
  });

  it('纯意图不算', () => {
    assert.equal(hasImplementationDetail('修正测试失败的断言'), false);
  });
});

describe('**好标签一个字都不改**', () => {
  const good = [
    '逐字照跑两条命令并回原始输出',
    '修正测试失败的断言',
    '清点项目内所有文件的文件名与行数',
    '改 judgeFailure 默认 kind 并跑构建',
  ];

  for (const sample of good) {
    it(`保持原样: ${sample.slice(0, 20)}`, () => {
      const r = displayLabel(sample);
      assert.equal(r.text, sample);
      assert.equal(r.wasCleaned, false);
    });
  }
});

describe('**清理不掉就保留原文**（不许出残句）', () => {
  // 这几条清理后是残句，必须回退
  const hard = [
    '用 edit_file 把 undo-ui-test.txt 改为「Agent改的」',
    '用 write_file 把根目录 conflict-test.txt 写成「Agent-A 写的内容」',
    'read_file a.txt',
  ];

  for (const sample of hard) {
    it(`回退到原文: ${sample.slice(0, 24)}`, () => {
      const r = displayLabel(sample);
      assert.equal(r.text, sample, '清理不出成句就保留原文');
      assert.equal(r.wasCleaned, false);
    });
  }

  it('**清完还成句的就用清理版**（去掉文件名不影响理解）', () => {
    // "统计根目录 数量并写入" —— 去掉两个 .txt 后仍然读得通
    const r = displayLabel('统计根目录 .txt 数量并写入 dep-a.txt');
    assert.ok(r.wasCleaned, '这条应该能清理');
    assert.ok(r.text.length >= 4);
    assert.ok(!/\.txt/.test(r.text), '不该残留扩展名');
  });

  it('**绝不返回"根目录""写 为"这类残句**', () => {
    const bad = [
      '用 write_file 把根目录 conflict-test.txt 写成「A」',
      'Agent2：write_file 写 race-a.txt 为「由B写」',
      '统计根目录 .txt 数量并写入 dep-a.txt',
    ];
    for (const s of bad) {
      const { text, wasCleaned } = displayLabel(s);
      if (wasCleaned) {
        assert.ok(text.length >= 4, `清出了残句: "${text}"`);
        assert.ok(!/^(根目录|目录|写 为|为)$/.test(text), `清出了残句: "${text}"`);
      }
    }
  });
});

describe('能清理时应该清理', () => {
  it('去掉工具名后还剩完整意图', () => {
    // "用 run_command 跑构建和单测" —— 去掉工具名后仍是完整句子
    const r = displayLabel('用 run_command 跑构建和单测');
    assert.equal(r.wasCleaned, true);
    assert.equal(r.text, '跑构建和单测');
  });
});

describe('边界', () => {
  it('空字符串不崩', () => {
    assert.deepEqual(displayLabel(''), { text: '', wasCleaned: false });
    assert.deepEqual(displayLabel('   '), { text: '', wasCleaned: false });
  });

  it('返回结构稳定', () => {
    const r = displayLabel('随便');
    assert.equal(typeof r.text, 'string');
    assert.equal(typeof r.wasCleaned, 'boolean');
  });
});

describe('**连续调用结果必须一致**（正则 lastIndex 污染）', () => {
  // 踩过：FILE_PATTERN 带 g 标志，test() 会记住 lastIndex。
  // 单独调用是对的，批量调用时第二次从上次结束位置开始匹配，
  // 造成"同样输入、不同结果"。实测统计脚本 34/36 条都判错了。
  it('同一条连续调用 5 次，结果相同', () => {
    const s = '把 notes.md 整个覆盖为指定两行内容';
    const results = Array.from({ length: 5 }, () => hasImplementationDetail(s));
    assert.deepEqual(results, [true, true, true, true, true]);
  });

  it('交替调用不同字符串也不串', () => {
    const a = '把 notes.md 覆盖';
    const b = '修正测试失败的断言';
    for (let i = 0; i < 3; i += 1) {
      assert.equal(hasImplementationDetail(a), true, `第 ${i + 1} 轮 a`);
      assert.equal(hasImplementationDetail(b), false, `第 ${i + 1} 轮 b`);
    }
  });
});

describe('**清理率**（判据不能过严）', () => {
  // 判据过严时实测 36 条里只有 3 条能清理。
  // 这些是"去掉文件名后仍然可读"的，必须能清理。
  const shouldClean = [
    ['把 notes.md 整个覆盖为指定两行内容', '把整个覆盖为指定两行内容'],
    ['核查 notes.md 现状与残留临时文件', '核查现状与残留临时文件'],
    ['分析 README/main.tex 结构（任务5，只读）', '分析结构（任务5，只读）'],
  ];

  for (const [input, expect] of shouldClean) {
    it(`能清理: ${String(input).slice(0, 24)}`, () => {
      const r = displayLabel(String(input));
      assert.equal(r.wasCleaned, true, '应该能清理');
      assert.equal(r.text, expect);
    });
  }

  // 这些清出来是残句，必须保留原文
  const shouldFallback = [
    '把 target.txt 的内容改成「已被 Agent 修改」',   // "把的内容改成"
    '用 write_file 把根目录 conflict-test.txt 写成「A」', // "根目录写成"
  ];

  for (const input of shouldFallback) {
    it(`保留原文: ${input.slice(0, 24)}`, () => {
      const r = displayLabel(input);
      assert.equal(r.wasCleaned, false, `不该清理成: ${r.text}`);
      assert.equal(r.text, input);
    });
  }
});

describe('空格处理', () => {
  it('中文之间的多余空格去掉', () => {
    const r = displayLabel('统计 chapters 目录下每个 .tex 文件的行数');
    assert.ok(!/统计\s+chapters目录/.test(r.text), `残留空格: ${r.text}`);
  });

  it('中英文之间保留一个空格', () => {
    const r = displayLabel('分析 README/main.tex 结构');
    assert.match(r.text, /分析\s*结构|分析结构/);
  });
});