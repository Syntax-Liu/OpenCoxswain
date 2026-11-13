/**
 * 发布前验收判据。
 *
 * 每一条判据都对应一个真实事故：
 *
 * | 判据 | 对应的事故 |
 * | --- | --- |
 * | 测试全过 | 基本要求 |
 * | 改动有测试 | 快照功能 9 个测试全过，但传参漏了——测试没覆盖真实调用路径 |
 * | 工作区干净 | 改一半发了 |
 * | 版本号已更新 | 忘了 bump，推送被拒 |
 * | 没有新增 TODO | 半成品不该发 |
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateRelease, needsTest, renderVerdict } from '../release/ready.js';

const facts = (over: Partial<Parameters<typeof evaluateRelease>[0]> = {}) => ({
  tests: { passed: 900, failed: 0 },
  changedFiles: ['apps/runtime/src/foo.ts'],
  changedTests: ['apps/runtime/src/test/foo.test.ts'],
  hasUncommitted: false,
  version: '1.0.0',
  previousVersion: '0.9.0',
  newTodos: 0,
  ...over,
});

describe('能不能发', () => {
  it('**全部满足 → 可以发**', () => {
    const v = evaluateRelease(facts());
    assert.equal(v.ready, true);
    assert.equal(v.summary, '可以发布');
  });

  it('**测试挂了 → 不能发**', () => {
    const v = evaluateRelease(facts({ tests: { passed: 900, failed: 3 } }));
    assert.equal(v.ready, false);
    assert.match(v.blockers.join(' '), /3 个测试失败/);
  });

  it('**改了源码没改测试 → 不能发**', () => {
    const v = evaluateRelease(facts({ changedFiles: ['src/a.ts', 'src/b.ts'], changedTests: [] }));
    assert.equal(v.ready, false);
    assert.match(v.blockers.join(' '), /没有改任何测试/);
  });

  it('**有未提交改动 → 不能发**', () => {
    const v = evaluateRelease(facts({ hasUncommitted: true }));
    assert.equal(v.ready, false);
    assert.match(v.blockers.join(' '), /工作区|对不上/);
  });

  it('**版本号没变 → 不能发**', () => {
    const v = evaluateRelease(facts({ version: '1.0.0', previousVersion: '1.0.0' }));
    assert.equal(v.ready, false);
    assert.match(v.blockers.join(' '), /没有更新/);
  });

  it('**查不到上一个版本 → 只提醒，不静默放行**', () => {
    const v = evaluateRelease(facts({ previousVersion: null }));
    assert.equal(v.ready, true);
    // 关键：状态是 warn，不是 pass
    assert.equal(v.checks.find((c) => c.id === 'version')?.status, 'warn');
    assert.match(v.summary, /提醒/);
  });

  it('新增 TODO 只是提醒，不拦发布', () => {
    const v = evaluateRelease(facts({ newTodos: 2 }));
    assert.equal(v.ready, true);
    assert.match(v.summary, /提醒/);
  });
});

describe('**测试数 0 必须判失败**', () => {
  it('一个测试都没跑出来 → 不能发', () => {
    // 真实踩过：pnpm 调用失败，输出里没有汇总行，
    // 结果显示"✓ 0 个测试全过"——比不检查更糟。
    const v = evaluateRelease(facts({ tests: { passed: 0, failed: 0 } }));
    assert.equal(v.ready, false);
    assert.match(v.blockers.join(' '), /没有跑出任何测试结果/);
  });
});

describe('**一次列出所有问题**', () => {
  it('不修一个报一个', () => {
    const v = evaluateRelease(
      facts({
        tests: { passed: 1, failed: 5 },
        hasUncommitted: true,
        version: '1.0.0',
        previousVersion: '1.0.0',
      }),
    );
    assert.equal(v.ready, false);
    // 三个问题一次全列出来
    assert.equal(v.blockers.length, 3);
  });
});

describe('哪些文件需要测试', () => {
  it('业务代码要', () => {
    assert.equal(needsTest('src/foo.ts'), true);
    assert.equal(needsTest('src/App.tsx'), true);
  });

  it('**测试文件自己不用**', () => {
    assert.equal(needsTest('src/test/foo.test.ts'), false);
    assert.equal(needsTest('src/a.test.ts'), false);
  });

  it('文档和配置不用', () => {
    assert.equal(needsTest('docs/a.md'), false);
    assert.equal(needsTest('package.json'), false);
    assert.equal(needsTest('src/styles.css'), false);
  });
});

describe('只改文档时', () => {
  it('不要求改测试', () => {
    const v = evaluateRelease(
      facts({ changedFiles: ['docs/a.md', 'README.md'], changedTests: [] }),
    );
    assert.equal(v.ready, true);
    assert.match(v.checks.find((c) => c.id === 'tested')?.detail ?? '', /没有改业务代码/);
  });
});

describe('渲染', () => {
  it('每条检查都带理由', () => {
    const text = renderVerdict(evaluateRelease(facts()));
    assert.match(text, /测试全过/);
    assert.match(text, /900 个测试全过/);
  });

  it('失败时给出结论', () => {
    const text = renderVerdict(evaluateRelease(facts({ tests: { passed: 1, failed: 1 } })));
    assert.match(text, /不能发布/);
  });
});
