import type { TaskContract } from '@opencoxswain/shared';

export function validContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: 'tsk_01',
    parent_id: null,
    project_id: 'prj_01',
    title: '修复夜间模式',
    goal: '切换夜间模式后立即生效',
    deliverables: [{ type: 'diff', scope: 'src/theme/**' }],
    acceptance_criteria: [
      { id: 'ac1', type: 'command', desc: '单测通过', check: 'node check.mjs' },
      { id: 'ac2', type: 'human', desc: '用户确认视觉' },
    ],
    dependencies: [],
    write_scope: ['src/theme/**'],
    budget: { usd: 2, tokens: 200000, minutes: 30 },
    ...overrides,
  };
}
