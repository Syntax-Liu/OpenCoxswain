/**
 * B4 界面细节的纯逻辑测试。
 *
 * 只测能测的部分：筛选匹配、滚动判定。
 * 真实的滚动与剪贴板需要浏览器，这里不假装测过。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRunning, matchExecutor, matchesProject } from '../components/matching.js';

const ex = (over: Partial<{ label: string; goal: string; status: any }> = {}) => ({
  label: '登录页重构',
  goal: '把登录页拆成组件',
  status: 'done' as const,
  ...over,
});

describe('Agent筛选', () => {
  it('空搜索返回全部', () => {
    assert.equal(matchExecutor(ex(), '', false), true);
  });

  it('匹配标题', () => {
    assert.equal(matchExecutor(ex(), '登录', false), true);
  });

  it('匹配目标（用户常记得目标不记得标题）', () => {
    assert.equal(matchExecutor(ex(), '拆成组件', false), true);
  });

  it('大小写不敏感', () => {
    assert.equal(matchExecutor(ex({ label: 'Fix Login' }), 'login', false), true);
  });

  it('不匹配的排除', () => {
    assert.equal(matchExecutor(ex(), '数据库', false), false);
  });

  it('"只看在跑"过滤掉已完成的', () => {
    assert.equal(matchExecutor(ex({ status: 'done' }), '', true), false);
    assert.equal(matchExecutor(ex({ status: 'running' }), '', true), true);
  });

  it('starting 也算在跑', () => {
    assert.equal(isRunning('starting'), true);
    assert.equal(matchExecutor(ex({ status: 'starting' }), '', true), true);
  });

  it('搜索与"只看在跑"可叠加', () => {
    assert.equal(matchExecutor(ex({ status: 'running' }), '登录', true), true);
    assert.equal(matchExecutor(ex({ status: 'done' }), '登录', true), false);
  });
});

describe('项目名匹配', () => {
  it('按项目名搜索', () => {
    assert.equal(matchesProject({ name: 'OpenCoxswain' }, 'cox', false), true);
    assert.equal(matchesProject({ name: 'OpenCoxswain' }, 'zzz', false), false);
  });

  it('"只看在跑"时不靠项目名保留文件夹', () => {
    assert.equal(matchesProject({ name: 'OpenCoxswain' }, '', true), false);
  });
});
