/**
 * 测试失败分类的判断逻辑。
 *
 * 核心约束：**默认判"实现有问题"，不能轻易判"测试过时"**。
 *
 * 理由：把"实现错了"误判成"测试过时"，会让人去改测试——
 * 等于把一个真 bug 掩盖掉。反过来误判代价小得多（多查一下实现）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { judgeFailure, parseFailures, renderFailureReport } from '../executor/testJudge.js';

// 取自真实的 node:test 输出
const REAL_OUTPUT = `
✖ failing tests:

test at sample.test.mjs:8:3
✖ **这条会失败** (0.5371ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  '1,2,3' !== '3,2,1'
  
      at TestContext.<anonymous> (file:///sample.test.mjs:9:12) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '1,2,3',
    expected: '3,2,1',
    operator: 'strictEqual',
    diff: 'simple'
  }
`;

describe('解析真实输出', () => {
  it('抽出失败条数', () => {
    assert.equal(parseFailures(REAL_OUTPUT).length, 1);
  });

  it('抽出测试名', () => {
    assert.equal(parseFailures(REAL_OUTPUT)[0]?.name, '**这条会失败**');
  });

  it('**抽出断言的实际值/期望值**', () => {
    const a = parseFailures(REAL_OUTPUT)[0]?.assertion;
    assert.equal(a?.actual, '1,2,3');
    assert.equal(a?.expected, '3,2,1');
    assert.equal(a?.operator, 'strictEqual');
  });

  it('抽出失败位置', () => {
    assert.equal(parseFailures(REAL_OUTPUT)[0]?.location, 'sample.test.mjs:8');
  });

  it('抽出错误类型', () => {
    assert.equal(parseFailures(REAL_OUTPUT)[0]?.errorType, 'AssertionError');
  });

  it('**不出现"未命名测试"这种噪声**', () => {
    const names = parseFailures(REAL_OUTPUT).map((f) => f.name);
    assert.ok(!names.some((n) => n.includes('未命名')), `不该有未命名: ${names}`);
  });

  it('没有失败时返回空', () => {
    assert.deepEqual(parseFailures('ℹ pass 843\nℹ fail 0'), []);
  });
});

describe('**判"实现有问题"是默认值**', () => {
  it('普通断言失败', () => {
    const [f] = parseFailures(REAL_OUTPUT);
    assert.equal(judgeFailure(f!).kind, 'implementation');
  });

  it('说明里带实际值和期望值（有依据，不是猜）', () => {
    const [f] = parseFailures(REAL_OUTPUT);
    const j = judgeFailure(f!);
    assert.match(j.reasoning, /1,2,3/);
    assert.match(j.reasoning, /3,2,1/);
  });

  it('建议里明确说"不要先改测试"', () => {
    const [f] = parseFailures(REAL_OUTPUT);
    assert.match(judgeFailure(f!).suggestion, /不要先改测试/);
  });
});

describe('环境问题', () => {
  const mk = (detail: string) => ({ name: 't', detail, errorType: 'Error' });

  it('**文件不存在**', () => {
    assert.equal(judgeFailure(mk('ENOENT: no such file or directory')).kind, 'environment');
  });

  it('命令找不到', () => {
    assert.equal(judgeFailure(mk('command not found: pnpm')).kind, 'environment');
  });

  it('**端口被占用**', () => {
    assert.equal(judgeFailure(mk('EADDRINUSE: address already in use')).kind, 'environment');
  });

  it('超时', () => {
    assert.equal(judgeFailure(mk('timeout of 30000ms exceeded')).kind, 'environment');
  });

  it('说明里指出重跑没用', () => {
    const j = judgeFailure(mk('ENOENT: no such file'));
    assert.match(j.suggestion, /不要改代码/);
  });
});

describe('**判"测试过时"需要充分证据**', () => {
  const staleFixture = {
    name: '排序测试',
    location: 'src/test/order.test.ts:42',
    errorType: 'AssertionError',
    assertion: { actual: 'c,b,a', expected: 'a,b,c', operator: 'deepEqual' },
    detail: 'assertion failed',
  };

  it('测试之前通过 + 这次没改测试 → 判过时', () => {
    const j = judgeFailure(staleFixture, {
      changedFiles: ['src/store/sqlite.ts'],
      previouslyPassing: true,
    });
    assert.equal(j.kind, 'stale-test');
  });

  it('**没有"之前通过"的记录 → 不判过时**', () => {
    const j = judgeFailure(staleFixture, { changedFiles: ['src/store/sqlite.ts'] });
    assert.notEqual(j.kind, 'stale-test');
  });

  it('**测试文件自己这次被改过 → 不判过时**', () => {
    const j = judgeFailure(staleFixture, {
      changedFiles: ['src/test/order.test.ts'],
      previouslyPassing: true,
    });
    assert.notEqual(j.kind, 'stale-test', '改了测试还判"测试过时"等于自说自话');
  });

  it('失败位置不在测试文件里 → 不判过时', () => {
    const j = judgeFailure(
      { ...staleFixture, location: 'src/store/sqlite.ts:100' },
      { changedFiles: [], previouslyPassing: true },
    );
    assert.notEqual(j.kind, 'stale-test');
  });

  it('判过时时要求说明为什么改', () => {
    const j = judgeFailure(staleFixture, { changedFiles: [], previouslyPassing: true });
    assert.match(j.suggestion, /写明为什么/);
  });
});

describe('**管道会吞掉退出码**', () => {
  it('退出码 0 但输出里有失败标记时，仍能解析出失败', () => {
    // 真实场景：`pnpm test 2>&1 | head` —— 退出码是 head 的，失败被吞
    const piped = `
ℹ tests 23
ℹ pass 22
ℹ fail 1

✖ failing tests:

test at a.test.mjs:5:3
✖ 某测试 (0.5ms)
  AssertionError: 1 !== 2
    actual: 1,
    expected: 2,
    operator: 'strictEqual'
`;
    const failures = parseFailures(piped);
    assert.equal(failures.length, 1, '管道输出里也必须能抽到失败');
    assert.equal(failures[0]?.name, '某测试');
  });

  it('全通过时抽不到失败', () => {
    assert.equal(parseFailures('ℹ tests 23\nℹ pass 23\nℹ fail 0').length, 0);
  });
});

describe('渲染', () => {
  it('给出分类统计', () => {
    const failures = [
      { name: 'a', detail: 'ENOENT' },
      { name: 'b', detail: 'assertion' },
    ];
    const judgments = failures.map((f) => judgeFailure(f));
    const text = renderFailureReport(failures, judgments);
    assert.match(text, /实现问题 \d+/);
    assert.match(text, /环境问题 \d+/);
  });

  it('每条都带判断和理由', () => {
    const failures = [{ name: '某测试', detail: 'assertion failed' }];
    const text = renderFailureReport(failures, [judgeFailure(failures[0]!)]);
    assert.match(text, /判断：implementation/);
    assert.match(text, /某测试/);
  });

  it('没有失败时明确说没有', () => {
    assert.match(renderFailureReport([], []), /没有失败/);
  });
});
