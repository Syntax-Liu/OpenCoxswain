/**
 * 侧栏批次分组测试。
 *
 * 核心约束：**单个会话不画批次装饰**。
 * 强调"批"但批次里只有一个，反而制造噪音。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutorDto } from '../api.js';
import { BATCH_WINDOW_MS } from '../components/batches.js';
import { computeBatchPositions } from '../components/sidebarBatches.js';

/** 造一个只关心 id 和创建时间的假 Agent。 */
const agent = (id: string, at: number): ExecutorDto =>
  ({ id, createdAt: at }) as unknown as ExecutorDto;

describe('单个会话', () => {
  it('**不画任何批次装饰**', () => {
    const r = computeBatchPositions([agent('a', 1000)]);
    assert.equal(r[0]?.position, 'none');
    assert.equal(r[0]?.batchSize, 1);
  });

  it('空列表返回空', () => {
    assert.deepEqual(computeBatchPositions([]), []);
  });
});

describe('同一批', () => {
  it('两个挨着的会话成一“批”', () => {
    const r = computeBatchPositions([agent('a', 1000), agent('b', 2000)]);
    assert.equal(r[0]?.position, 'first');
    assert.equal(r[1]?.position, 'last');
    assert.equal(r[0]?.batchSize, 2);
  });

  it('三个会话：首、中、尾', () => {
    const r = computeBatchPositions([
      agent('a', 1000),
      agent('b', 2000),
      agent('c', 3000),
    ]);
    assert.deepEqual(
      r.map((x) => x.position),
      ['first', 'middle', 'last'],
    );
  });

  it('**刚好在窗口内算同批**', () => {
    const r = computeBatchPositions([agent('a', 0), agent('b', BATCH_WINDOW_MS)]);
    assert.equal(r[0]?.batchSize, 2);
  });

  it('**超出窗口就是两批**', () => {
    const r = computeBatchPositions([agent('a', 0), agent('b', BATCH_WINDOW_MS + 1)]);
    assert.equal(r[0]?.position, 'none');
    assert.equal(r[1]?.position, 'none');
  });
});

describe('多批', () => {
  it('两批各自成组', () => {
    const r = computeBatchPositions([
      agent('a', 0),
      agent('b', 1000),
      agent('c', 200_000),
      agent('d', 201_000),
    ]);
    assert.deepEqual(
      r.map((x) => x.position),
      ['first', 'last', 'first', 'last'],
    );
  });

  it('单批和双批混在一起', () => {
    const r = computeBatchPositions([agent('solo', 0), agent('a', 200_000), agent('b', 201_000)]);
    assert.equal(r[0]?.position, 'none', '单独的会话不该被标成 first');
    assert.equal(r[1]?.position, 'first');
    assert.equal(r[2]?.position, 'last');
  });
});

describe('顺序无关', () => {
  it('**输入不是时间序也能正确判定**', () => {
    // b 比 a 早，但传进来的顺序是 a、b
    const r = computeBatchPositions([agent('b', 2000), agent('a', 1000)]);
    // 按时间 a 是 first，b 是 last；输出顺序跟着输入
    assert.equal(r[0]?.batchSize, 2);
    assert.equal(r[1]?.batchSize, 2);
    assert.equal(r[0]?.position, 'last', 'b 在时间上是最后一个');
    assert.equal(r[1]?.position, 'first', 'a 在时间上是第一个');
  });
});
