/**
 * 整轮回滚的前端接线。
 *
 * ## 为什么需要测这个
 *
 * 之前踩过：组件里写好了渲染代码，但 App 忘了传 props——
 * typecheck 不报错（props 可选），按钮永远不出现。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const exec = readFileSync(new URL('../../src/components/ExecutorChat.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8');
const css = allCss;

describe('**整轮回滚：App 真的接线了**', () => {
  it('有 handleRollbackAll', () => {
    assert.match(app, /const handleRollbackAll = useCallback/);
  });

  it('ExecutorChat 收到了 onRollbackAll', () => {
    const m = /<ExecutorChat[\s\S]*?\/>/.exec(app);
    assert.ok(m, '找不到 ExecutorChat');
    assert.match(m[0], /onRollbackAll=/, 'App 没传 onRollbackAll，按钮永远不出现');
  });

  it('回滚走 api.rollbackCheckpoint', () => {
    assert.match(app, /api\.rollbackCheckpoint\(/);
  });

  it('回滚前有确认框，说明会跳过手工修改', () => {
    const m = /handleRollbackAll[\s\S]{0,800}/.exec(app);
    assert.ok(m);
    assert.match(m[0], /window\.confirm/);
    assert.match(m[0], /手工改过的文件会被跳过/);
  });
});

describe('**撤销成功走 notice，不走 error**', () => {
  it('undoEffect 之后是 setNotice', () => {
    const m = /const result = await api\.undoEffect[\s\S]{0,200}/.exec(app);
    assert.ok(m);
    assert.match(m[0], /setNotice\(result\.message\)/);
    assert.doesNotMatch(m[0], /setError\(result\.message\)/, '成功文案不能当错误显示');
  });
});

describe('EffectsBlock 的按钮', () => {
  it('有整轮回滚按钮', () => {
    assert.match(exec, /eff-rollback-all/);
    assert.match(exec, /全部回滚/);
  });

  it('**只有 2 个以上可撤销文件才显示**', () => {
    // 一个文件的话单条撤销更快
    assert.match(exec, /effects\.filter\(canUndo\)\.length > 1/);
  });

  it('props 类型里有 onRollbackAll', () => {
    assert.match(exec, /onRollbackAll\?: \(\) => void/);
  });
});

describe('api.ts 有检查点方法', () => {
  it('checkpoints()', () => {
    assert.match(api, /checkpoints\(executorId: string/);
  });

  it('rollbackCheckpoint()', () => {
    assert.match(api, /rollbackCheckpoint\(/);
    assert.match(api, /\/rollback`/, 'URL 要以 /rollback 结尾');
  });

  it('有 CheckpointDto 类型', () => {
    assert.match(api, /export interface CheckpointDto/);
  });
});

describe('样式', () => {
  it('.effects-head 是横排两端对齐', () => {
    const m = /\.effects-head\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    assert.ok(m);
    assert.match(m[1] ?? '', /justify-content:\s*space-between/);
  });
});
