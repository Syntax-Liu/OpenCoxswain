import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * 汇报轮不能被谎报重试打断。
 *
 * ## 实测（2026-11-15 用户反馈）
 *
 * > Agent 跑完了，Assistant 没有及时汇报结果
 *
 * 数据库时间线：
 *
 *   15:41:02  internal:executor  【Agent结算】Agent「定位前端提示」已完成
 *   15:41:02  assistant          Agent 的输出（summary）
 *   15:41:02  assistant          排查完成。以下是完整结论…     ← 这才是汇报
 *   15:41:06  internal:system    你上一条说「已派出」但本轮没调工具
 *   15:41:08  assistant          ⚠ 更正：上一条说的「已派出」不成立
 *
 * **汇报被更正盖掉了**。用户只看到"更正"，看不到 Agent 干完了什么。
 *
 * ## 根因
 *
 * 同一轮里：结算通知 + 用户消息都到了。模型既汇报了结果、
 * 又顺口说"我再派一个"（谎报）→ 整轮被重试覆盖 → 汇报丢失。
 *
 * ## 修法
 *
 * 本轮若有【Agent结算】通知 → **汇报优先**：
 * - 不触发重试（重试会把汇报顶掉）
 * - 不追加更正（更正会盖住汇报的最后一条）
 *
 * 谎报那句仍然不进历史（防污染），只是不再用重试去"修"。
 */
describe('**汇报轮不被重试打断**', () => {
  const src = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('识别出"本轮有结算通知"', () => {
    assert.match(
      src,
      /reportingTurn\s*=[\s\S]{0,200}INTERNAL_NOTICE_PREFIX/,
      '没识别汇报轮 —— 分不清"该汇报"和"该派活"',
    );
  });

  it('**重试条件里排除汇报轮**', () => {
    assert.match(
      src,
      /audit\.wrong && !reportingTurn/,
      '汇报轮仍在重试 —— 汇报会被顶掉',
    );
  });

  it('**汇报轮不追加更正**（更正会盖住结果）', () => {
    // 找 if (audit.wrong) 那段，应该先判 reportingTurn
    const start = src.indexOf('if (audit.wrong) {');
    assert.ok(start > 0, '找不到 audit.wrong 分支');
    const block = src.slice(start, start + 900);
    assert.match(block, /reportingTurn/, '汇报轮仍在追加更正');
  });

  it('汇报轮仍把正文写进历史（用户要的结论不能丢）', () => {
    assert.match(
      src,
      /else if \(reportingTurn\)[\s\S]{0,300}recordAssistant/,
      '汇报轮的正文没落库 —— 刷新后用户就看不到了',
    );
  });
});
