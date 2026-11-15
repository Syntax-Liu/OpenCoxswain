/**
 * "预告派活"检测。
 *
 * 真实事故：Assistant 声称"已派出 exe_mwerrc1kx3y0j"，
 * 但没调 spawn_executor，数据库里查不到。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditSpawnClaims, claimsSpawn, correctionText } from '../assistant/spawnClaim.js';

describe('识别"已派出"声明', () => {
  it('**真实事故原话**', () => {
    const text =
      '已派出 **exe_mwerrc1kx3y0j**（只读，`writeScope: ["readonly"]`）。\n' +
      '它要交付：`chapters/` 下每个 `.tex` 的文件名 + 行数。';
    assert.deepEqual(claimsSpawn(text), ['exe_mwerrc1kx3y0j']);
  });

  it('不带粗体也认', () => {
    assert.deepEqual(claimsSpawn('已派出 exe_abc123，状态 running'), ['exe_abc123']);
  });

  it('一条回复里多个', () => {
    const text = '已派出 exe_aaa\n已派出 exe_bbb';
    assert.deepEqual(claimsSpawn(text), ['exe_aaa', 'exe_bbb']);
  });

  it('只说"我将派出"不算（这是允诺，不是声明）', () => {
    assert.deepEqual(claimsSpawn('我将派出一个 Agent 去做'), []);
  });

  it('没有 id 的"已派出"不算（无法核对，不冤判）', () => {
    assert.deepEqual(claimsSpawn('已派出一个 Agent 去统计'), []);
  });

  it('普通文字不误报', () => {
    assert.deepEqual(claimsSpawn('这个任务已经完成了，结果如下'), []);
  });
});

describe('**核对是否真的派了**', () => {
  it('说了且真的派了 → 没问题', () => {
    const r = auditSpawnClaims('已派出 exe_abc', ['exe_abc']);
    assert.equal(r.wrong, false);
    assert.deepEqual(r.phantomIds, []);
  });

  it('**说了但没派 → 幽灵**', () => {
    const r = auditSpawnClaims('已派出 exe_abc', []);
    assert.equal(r.wrong, true);
    assert.deepEqual(r.phantomIds, ['exe_abc']);
  });

  it('说了一个真一个假 → 报出假的那个', () => {
    const r = auditSpawnClaims('已派出 exe_real 和 exe_fake', ['exe_real']);
    assert.equal(r.wrong, true);
    assert.deepEqual(r.phantomIds, ['exe_fake']);
  });

  it('没声称 → 不管派没派都不报', () => {
    const r = auditSpawnClaims('我正在处理', ['exe_abc']);
    assert.equal(r.wrong, false);
  });
});

describe('**不带 id 的笼统声称**也要抓', () => {
  // 实测 2026-11-15：模型回复「已派出，这两个都在跑」，
  // 但本轮没调用任何工具，running=0。
  // 原检测只认「已派出 + exe_ id」，这句不含 id 就漏了。
  it('「已派出，两个都在跑」+ 实际没派 → 报错', () => {
    const r = auditSpawnClaims('收到，这两件事我会一起并行派出两个只读 Agent。已派出，两个都在跑。', []);
    assert.equal(r.wrong, true);
    assert.equal(r.vagueClaim, true);
    assert.deepEqual(r.phantomIds, []);
  });

  it('带数量的「已派出两个 Agent」+ 实际没派 → 报错', () => {
    const r = auditSpawnClaims('已派出两个 Agent，它们会并行处理。', []);
    assert.equal(r.wrong, true);
    assert.equal(r.vagueClaim, true);
  });

  it('「都在跑」+ 实际没派 → 报错', () => {
    const r = auditSpawnClaims('两个都在跑，稍等。', []);
    assert.equal(r.wrong, true);
    assert.equal(r.vagueClaim, true);
  });

  it('**真派了就不报**（同一句话）', () => {
    const r = auditSpawnClaims('已派出，两个都在跑。', ['exe_a', 'exe_b']);
    assert.equal(r.wrong, false);
    assert.equal(r.vagueClaim, false);
  });

  it('普通叙述不误报', () => {
    for (const text of [
      '我先看一下这个项目。',
      '要派 Agent 吗？',
      '可以派两个并行做，你确认一下。',
    ]) {
      const r = auditSpawnClaims(text, []);
      assert.equal(r.wrong, false, `误报：${text}`);
    }
  });

  it('无 id 的纠正话术不含具体 id', () => {
    const t = correctionText([], true);
    assert.match(t, /更正/);
    assert.match(t, /没有创建任何 Agent/);
    assert.doesNotMatch(t, /exe_/);
  });
});

describe('**id 与"派出"之间有文字**也要抓', () => {
  // 实测 2026-11-15：模型写「我派出 Agent (exe_xxx) 进行只读统计」，
  // "派出"和 id 之间隔着 "Agent ("，原正则要求紧邻，漏了。
  it('「派出 Agent (exe_x)」能识别', () => {
    const ids = claimsSpawn('收到，我派出 Agent (exe_mweq2c1l25rcy) 进行只读统计。');
    assert.deepEqual(ids, ['exe_mweq2c1l25rcy']);
  });

  it('这种写法 + 实际没创建 → 报错', () => {
    const r = auditSpawnClaims('我派出 Agent (exe_fake) 进行统计。', []);
    assert.equal(r.wrong, true);
    assert.deepEqual(r.phantomIds, ['exe_fake']);
  });

  it('「交给 exe_x 处理」也能识别', () => {
    assert.deepEqual(claimsSpawn('这件事交给 exe_abc 处理'), ['exe_abc']);
  });

  it('只是提到 id 不误报', () => {
    assert.deepEqual(claimsSpawn('数据库里没有 exe_abc 这条记录'), []);
  });
});

describe('纠正话术', () => {
  it('**说明那句话不成立**，不说"可能"', () => {
    const t = correctionText(['exe_fake']);
    assert.match(t, /更正/);
    assert.match(t, /不成立/);
    assert.match(t, /exe_fake/);
    assert.match(t, /没有创建任何 Agent/);
  });

  it('告诉用户下一步能做什么', () => {
    assert.match(correctionText(['exe_x']), /需要我现在派吗/);
  });

  it('多个 id 都列出来', () => {
    const t = correctionText(['exe_a', 'exe_b']);
    assert.match(t, /exe_a/);
    assert.match(t, /exe_b/);
  });

  it('空列表返回空串', () => {
    assert.equal(correctionText([]), '');
  });
});
