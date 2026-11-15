/**
 * 撤销按钮的显示规则测试。
 *
 * 核心约束：**不能给撤不了的动作显示撤销按钮**。
 * 点了必然失败的按钮比没有按钮更让人困惑。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** 与 ExecutorChat 里的 canUndo 保持一致的判定。 */
function canUndo(effect: {
  kind: string;
  reversible: boolean;
  state: string;
}): boolean {
  return effect.kind === 'fs.write' && effect.reversible && effect.state === 'succeeded';
}

describe('可撤销', () => {
  it('**成功的文件写入可以撤**', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: true, state: 'succeeded' }), true);
  });
});

describe('不可撤销', () => {
  it('**命令执行不能撤**', () => {
    assert.equal(canUndo({ kind: 'proc.exec', reversible: true, state: 'succeeded' }), false);
  });

  it('对外发送不能撤', () => {
    assert.equal(canUndo({ kind: 'net.send', reversible: true, state: 'succeeded' }), false);
  });

  it('删文件不能撤（没有原内容）', () => {
    assert.equal(canUndo({ kind: 'fs.delete', reversible: true, state: 'succeeded' }), false);
  });

  it('标了不可逆的一律不能撤', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: false, state: 'succeeded' }), false);
  });
});

describe('状态不对', () => {
  it('**已撤销的不再显示按钮**', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: true, state: 'undone' }), false);
  });

  it('进行中不能撤', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: true, state: 'pending' }), false);
  });

  it('失败的不显示（本来就没改成功）', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: true, state: 'failed' }), false);
  });

  it('被拒绝的不显示（没执行）', () => {
    assert.equal(canUndo({ kind: 'fs.write', reversible: true, state: 'rejected' }), false);
  });
});
