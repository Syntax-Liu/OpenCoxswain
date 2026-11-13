import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { SupervisionAction, Task, TaskReplay } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

test('G4 规则监察：重复工具调用先提示并留下审计记录', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(fixture.home, { supervisionIntervalMs: 100 });
  try {
    const project = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '重复调用也应有监察',
          subtasks: [
            {
              title: '实施：重复尝试',
              goal: '反复尝试同一个命令',
              role: 'implementer',
              writeScope: ['note.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认' }],
              inputs: {
                mock: {
                  actionDelayMs: 200,
                  actions: Array.from({ length: 6 }, () => ({
                    tool: 'shell',
                    input: { cmd: 'npm test' },
                  })),
                  files: [{ path: 'note.txt', content: 'after\n' }],
                },
              },
            },
            {
              title: '撰写：补文档',
              goal: '写一份说明',
              role: 'writer',
              writeScope: ['docs/'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认文档' }],
              inputs: { mock: { files: [{ path: 'docs/NOTE.md', content: '# note\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    const implementer = planned.children[0]!;
    const replay = await waitFor(async () => {
      const current = await daemon.call<TaskReplay>(`/api/tasks/${implementer.id}/replay`);
      return current.supervision.length > 0 ? current : null;
    });

    const nudge = replay.supervision.find(
      (action: SupervisionAction) => action.rule === 'repeated_fingerprint',
    );
    assert.ok(nudge, '应记录 repeated_fingerprint 监察动作');
    assert.equal(nudge?.verdict, 'nudge');
    assert.match(nudge?.reason ?? '', /相同工具调用/);
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
