import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryEntry } from '@opencoxswain/shared';
import { rankEntries, scoreEntry } from '../index.js';

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? 'mem_1',
    projectId: null,
    kind: 'profile',
    key: null,
    text: '默认文本',
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    useCount: 0,
    supersededBy: null,
    ...overrides,
  };
}

const NOW = 1_800_000_000_000;

test('关键词覆盖率越高分越高', () => {
  const full = scoreEntry(entry({ text: '偏好 pnpm 与 TypeScript' }), ['pnpm', 'typescript'], NOW);
  const partial = scoreEntry(entry({ id: 'mem_2', text: '偏好 pnpm' }), ['pnpm', 'typescript'], NOW);
  assert.ok(full && partial);
  assert.ok(full.score > partial.score);
  assert.deepEqual(full.matched, ['pnpm', 'typescript']);
});

test('时间衰减：越新越靠前，但关键词命中的旧记忆仍可进入结果', () => {
  const recent = entry({ id: 'mem_new', text: '验收命令使用 pnpm test', updatedAt: NOW });
  const old = entry({ id: 'mem_old', text: '验收命令使用 pnpm test', updatedAt: NOW - 200 * 86_400_000 });
  const matches = rankEntries([old, recent], 'pnpm test', NOW, 5);
  assert.equal(matches[0]?.entry.id, 'mem_new');
  assert.equal(matches.length, 2);
  assert.match(matches[0]!.reason, /命中/);
});

test('无命中返回空数组', () => {
  assert.deepEqual(rankEntries([entry({ text: '偏好 pnpm' })], '夜间模式', NOW, 5), []);
});
