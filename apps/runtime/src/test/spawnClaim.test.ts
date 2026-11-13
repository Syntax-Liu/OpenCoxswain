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
