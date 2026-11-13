/**
 * 「什么算需要用户拍板」的判据。
 *
 * 核心约束：**宁可少标，不可多标。**
 *
 * 漏标一条，用户晚点自己会发现；
 * 多标十条，用户以后就再也不看这个面板了。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionLead, needsUserDecision } from '../orchestrator/decisionRules.js';

describe('**不该打扰用户的**', () => {
  it('**Agent 普通失败**（能自己重试的）', () => {
    assert.equal(
      needsUserDecision({ kind: 'failed', body: 'Agent「清理文件」未完成。命令失败：ENOENT' }),
      false,
    );
  });

  it('**完成汇报**（哪怕带了建议）', () => {
    assert.equal(
      needsUserDecision({ kind: 'done', body: '结论：这个项目是 LaTeX 学习笔记。建议下一步加测试。' }),
      false,
    );
  });

  it('进度更新', () => {
    assert.equal(needsUserDecision({ kind: 'progress', body: '已读了 12 个文件' }), false);
  });

  it('**内容正常的问句不算**（正文里有"？"不代表是决策）', () => {
    assert.equal(needsUserDecision({ kind: 'done', body: '这个项目做什么的？我查清了。' }), false);
  });
});

describe('**该打扰用户的**', () => {
  it('Agent 卡住', () => {
    assert.equal(needsUserDecision({ kind: 'blocked', body: '需要用户决定是否继续' }), true);
  });

  it('**达到用量上限**', () => {
    assert.equal(
      needsUserDecision({ kind: 'blocked', body: '达到用量上限，要不要继续' }),
      true,
    );
  });

  it('**需要用户在外部提供东西**', () => {
    assert.equal(
      needsUserDecision({ kind: 'question', body: '需要你提供 GitHub token 才能继续' }),
      true,
    );
  });

  it('需要授权', () => {
    assert.equal(needsUserDecision({ kind: 'question', body: '请授权访问这个仓库' }), true);
  });
});

describe('显式表态优先', () => {
  it('调用方明确说**要** → 要（内容也得像提问）', () => {
    // 注意：现在 explicit:true 还要过内容检查——
    // 只说"要"但内容是汇报的，仍然不算（见下面那组测试）。
    assert.equal(
      needsUserDecision({ kind: 'progress', body: '要不要现在开始？', explicit: true }),
      true,
    );
  });

  it('调用方明确说**不要** → 不要', () => {
    assert.equal(
      needsUserDecision({ kind: 'blocked', body: '卡住了', explicit: false }),
      false,
    );
  });
});

describe('开头一句要点', () => {
  it('卡住时说清楚', () => {
    assert.match(decisionLead('blocked', '随便'), /卡住/);
  });

  it('用量上限时说要继续吗', () => {
    assert.match(decisionLead('blocked', '已按用量上限中止'), /要不要继续/);
  });

  it('需要外部操作时说清楚', () => {
    assert.match(decisionLead('question', '需要你提供一个 token'), /外部/);
  });
});

describe('**卡点分类标记**', () => {
  it('kind 是 failed 但带"需用户决定"标记 → 算', () => {
    // 真实数据里没有 kind=blocked 的报告，卡点都记成了 failed。
    // 只看 kind 会全部漏掉。
    assert.equal(
      needsUserDecision({
        kind: 'failed',
        body: 'Agent「改 undo-test.txt」未完成。\n[卡点分类：需用户决定] 系统复核未通过：内容与期望不一致',
      }),
      true,
    );
  });

  it('没有标记的 failed 不算', () => {
    assert.equal(
      needsUserDecision({
        kind: 'failed',
        body: 'Agent「清点文件」未完成。\n（无原因）\n两种方式都得到 12 个文件。',
      }),
      false,
    );
  });
});

describe('**"请确认"要出现在句子开头才算请求**', () => {
  it('句子中间的"请确认"是建议，不算', () => {
    // 真实误判：这是完成汇报里的建议
    assert.equal(
      needsUserDecision({
        kind: 'done',
        body: '可能它已被删除/移动，或在另一台机器上——如果这个告警来自别处，请确认来源。',
      }),
      false,
    );
  });

  it('句子开头的"请确认"算请求', () => {
    assert.equal(
      needsUserDecision({ kind: 'done', body: '已完成核对。请确认仓库地址是否正确。' }),
      true,
    );
  });

  it('换行开头的"请确认"也算', () => {
    assert.equal(
      needsUserDecision({ kind: 'question', body: '结论如下。\n请确认是否继续。' }),
      true,
    );
  });
});

describe('真实样本回归', () => {
  // 这些都曾出现在界面上，被误标成待决策
  const noise = [
    'Agent「清点项目内所有 .tex 文件并统计行数」未完成。\n（无原因）\n两种方式都得到 12 个文件。',
    '**结论**：advmath 是一个用 LaTeX 排版、按知识点模块化组织的学习笔记项目。',
    '**结论**：`undo-test.txt` 现在是「Agent修改后的内容」，交付时刻已读回复验通过。',
  ];

  for (const [i, body] of noise.entries()) {
    it(`**噪音样本 ${i + 1} 不算待决策**`, () => {
      assert.equal(needsUserDecision({ kind: 'failed', body }), false);
    });
  }

  it('真正的卡点仍算', () => {
    assert.equal(
      needsUserDecision({
        kind: 'blocked',
        body: '[卡点分类：需用户决定] 系统复核未通过：undo-test.txt 内容与期望不一致',
      }),
      true,
    );
  });
});

describe('**"要用户决定"却只是汇报**（实测最常见的误标）', () => {
  // 这 4 条都是从数据库里捞的真实样本：
  // Assistant 调 report_to_user 时习惯性把 needsUser 设成 true，
  // 但内容是结论汇报，不是提问。
  const reports = [
    '**结论**：advmath 是一个用 LaTeX 排版、按知识点模块化组织的学习笔记项目。',
    '**结论**：`undo-test.txt` 现在是「Agent修改后的内容」（23 字节），交付时刻已读回复验通过。',
    '**结论**：任务 2–5 全部跑完，5 份报告结论一致——项目无 README。',
    '## 结论\n我倾向 **先做 B**，不上 C。先说清一个前提：这个项目没有 git。',
  ];

  for (const [i, body] of reports.entries()) {
    it(`**即使 explicit=true 也不算**（样本 ${i + 1}）`, () => {
      assert.equal(needsUserDecision({ kind: 'question', body, explicit: true }), false);
    });
  }

  it('正文里有问号的口径 → 算', () => {
    assert.equal(
      needsUserDecision({
        kind: 'question',
        body: '**结论**：查清了。要不要现在就开始改？',
        explicit: true,
      }),
      true,
    );
  });

  it('"要不要"也算提问', () => {
    assert.equal(
      needsUserDecision({ kind: 'question', body: '结论如下。要不要继续。', explicit: true }),
      true,
    );
  });

  it('**代码块里的问号不算**（那不是问用户）', () => {
    assert.equal(
      needsUserDecision({
        kind: 'question',
        body: '结论：项目正常。\n```\nconst x = a ? b : c\n```\n改好了。',
        explicit: true,
      }),
      false,
    );
  });

  it('**卡点标记优先**——系统判定的比模型自述可信', () => {
    assert.equal(
      needsUserDecision({
        kind: 'failed',
        body: 'Agent 未完成。\n[卡点分类：需用户决定] 系统复核未通过',
        explicit: true,
      }),
      true,
    );
  });
});