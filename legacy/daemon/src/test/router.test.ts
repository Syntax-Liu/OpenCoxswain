import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type {
  MemoryEntry,
  MemoryMatch,
  Project,
  RouteSuggestion,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import { makeDaemon, makeRepo } from './helpers.js';

test('全局路由：只给建议与依据，不建单；跨项目记忆检索不改变使用统计', async () => {
  const fixture = await makeRepo({
    'README.md': 'login\n',
    'package.json': JSON.stringify({ name: 'login', packageManager: 'pnpm@9.0.0' }),
  });
  const other = await makeRepo({
    'README.md': 'pay\n',
    'package.json': JSON.stringify({ name: 'pay', packageManager: 'pnpm@9.0.0' }),
  });
  const { app, call } = await makeDaemon(fixture.home);
  try {
    const login = await call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo, name: '登录服务' }),
    });
    const pay = await call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: other.repo, name: '支付后台' }),
    });

    await call('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'project',
        text: '登录页在 Safari 下偶发白屏',
        projectId: login.id,
      }),
    });
    await call('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'project',
        text: '退款按钮需要二次确认',
        projectId: pay.id,
      }),
    });

    const routed = await call<{ suggestions: RouteSuggestion[] }>('/api/route', {
      method: 'POST',
      body: JSON.stringify({ goal: '登录页在 Safari 下白屏，排查并修复' }),
    });
    assert.ok(routed.suggestions.length >= 1, '相关性足够的项目进入候选');
    const top = routed.suggestions[0]!;
    assert.equal(top.projectId, login.id);
    assert.ok(top.score > 0);
    assert.ok(top.reasons.length > 0, '必须给出命中依据而不是黑箱');
    assert.ok(
      !routed.suggestions.some((item) => item.projectId === pay.id),
      '不相关项目不进入候选',
    );

    const unrelated = await call<{ suggestions: RouteSuggestion[] }>('/api/route', {
      method: 'POST',
      body: JSON.stringify({ goal: '整理季度财务报表' }),
    });
    assert.equal(unrelated.suggestions.length, 0);

    await assert.rejects(
      call('/api/route', { method: 'POST', body: JSON.stringify({ goal: '  ' }) }),
      /目标不能为空/,
    );

    const before = await call<WorkbenchSnapshot>(`/api/bootstrap?projectId=${login.id}`);
    assert.equal(before.tasks.length, 0, '路由只给建议，不建单');

    // 跨项目检索：两个项目的技术栈记忆都含 pnpm，应同时命中。
    const all = await call<{ matches: MemoryMatch[] }>(
      `/api/memory?scope=all&q=${encodeURIComponent('pnpm')}`,
    );
    const projectIds = new Set(all.matches.map((match) => match.entry.projectId));
    assert.ok(projectIds.has(login.id), '跨项目检索覆盖第一个项目');
    assert.ok(projectIds.has(pay.id), '跨项目检索覆盖第二个项目');
    assert.ok(
      all.matches.every((match) => match.entry.useCount === 0 && match.entry.lastUsedAt === null),
      '检索是只读的，不改变使用统计',
    );

    // 不带 scope 时语义不变：只查全局记忆。
    const scoped = await call<{ matches: MemoryMatch[] }>(
      `/api/memory?q=${encodeURIComponent('pnpm')}`,
    );
    assert.ok(scoped.matches.every((match) => match.entry.projectId === null));

    const after = await call<{ entries: MemoryEntry[] }>(`/api/memory?projectId=${login.id}`);
    const entry = after.entries.find((item) => item.text.includes('登录页'));
    assert.ok(entry);
    assert.equal(entry!.useCount, 0);
    assert.equal(entry!.lastUsedAt, null);
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true });
    await rm(other.temp, { recursive: true, force: true });
  }
});
