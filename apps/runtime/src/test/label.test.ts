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
