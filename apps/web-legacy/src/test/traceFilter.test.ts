/**
 * 轨迹筛选测试。
 *
 * 核心约束：**"被拒绝"也算失败**。
 * 审批被拒、被沙箱拦截，不是错误但也不是成功——
 * 排查"为什么没做成"时必须能看到它们。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countByFilter, filterTrace, isFailedEntry, isWriteEntry } from '../components/traceFilter.js';
import type { TraceEntry } from '../components/trace.js';

const entry = (over: Partial<TraceEntry>): TraceEntry =>
  ({
    id: 'x',
    kind: 'tool',
    label: '',
    title: '',
    detail: '',
    ...over,
  }) as TraceEntry;

describe('失败判定', () => {
  it('工具报错算失败', () => {
    assert.equal(isFailedEntry(entry({ title: 'read_file 失败' })), true);
  });

  it('**被拒绝算失败**（不是错误，但这一步没成）', () => {
    assert.equal(isFailedEntry(entry({ detail: '危险动作未获批准，没有执行' })), true);
  });

  it('**被拦截算失败**', () => {
    assert.equal(isFailedEntry(entry({ detail: '命令里含写操作已被拦截' })), true);
  });

  it('英文错误也认', () => {
    assert.equal(isFailedEntry(entry({ title: 'tool error: ENOENT' })), true);
  });

  it('正常记录不算失败', () => {
    assert.equal(isFailedEntry(entry({ title: 'read_file', detail: '读到了内容' })), false);
  });
});

describe('写操作判定', () => {
  it('write_file 算写', () => {
    assert.equal(isWriteEntry(entry({ title: 'write_file {"path":"a.txt"}' })), true);
  });

  it('edit_file 算写', () => {
    assert.equal(isWriteEntry(entry({ title: 'edit_file {"path":"a.txt"}' })), true);
  });

  it('run_command 算写（可能改任何东西）', () => {
    assert.equal(isWriteEntry(entry({ title: 'run_command "npm test"' })), true);
  });

  it('读操作不算写', () => {
    assert.equal(isWriteEntry(entry({ title: 'read_file', kind: 'tool' as never, detail: '' })), true);
  });
});

describe('过滤', () => {
  const entries = [
    entry({ id: '1', title: 'read_file', detail: 'ok' }),
    entry({ id: '2', title: 'write_file', detail: '已写入 a.txt' }),
    entry({ id: '3', title: 'run_command', detail: '失败：ENOENT' }),
    entry({ id: '4', title: 'edit_file', detail: '已修改 b.txt' }),
    entry({ id: '5', title: 'approve', detail: '危险动作未获批准，没有执行' }),
  ];

  it('全部不过滤', () => {
    assert.equal(filterTrace(entries, 'all', '').length, 5);
  });

  it('**只看失败**', () => {
    const out = filterTrace(entries, 'failed', '');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.id), ['3', '5']);
  });

  it('只看写操作', () => {
    const out = filterTrace(entries, 'writes', '');
    assert.ok(out.length >= 3);
  });

  it('**筛子和搜索词可以叠加**', () => {
    const out = filterTrace(entries, 'failed', 'ENOENT');
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, '3');
  });

  it('搜索词不区分大小写', () => {
    const out = filterTrace(entries, 'all', 'WRITE_FILE');
    assert.equal(out.length, 1);
  });

  it('没有匹配返回空', () => {
    assert.deepEqual(filterTrace(entries, 'all', 'zzz'), []);
  });

  it('空输入返回空', () => {
    assert.deepEqual(filterTrace([], 'failed', ''), []);
  });
});

describe('计数', () => {
  const entries = [
    entry({ id: '1', title: 'read_file', detail: 'ok' }),
    entry({ id: '2', title: 'write_file', detail: '已写入' }),
    entry({ id: '3', title: 'run_command', detail: '失败' }),
  ];

  it('给出每类的数量', () => {
    const c = countByFilter(entries);
    assert.equal(c.all, 3);
    assert.equal(c.failed, 1);
    assert.ok(c.writes >= 2);
  });

  it('空列表全是 0', () => {
    const c = countByFilter([]);
    assert.equal(c.all, 0);
    assert.equal(c.failed, 0);
  });
});
