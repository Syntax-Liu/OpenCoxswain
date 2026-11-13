import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasWriteConflict,
  readyTaskIds,
  validateDag,
  writeScopeConflicts,
  type DagTask,
} from '../dag.js';

const task = (id: string, status: DagTask['status'] = 'queued', writeScope: string[] = []): DagTask => ({
  id,
  status,
  writeScope,
  readOnly: false,
  createdAt: 0,
});

test('检测依赖环', () => {
  const errors = validateDag(
    [task('a'), task('b')],
    [
      { fromTaskId: 'a', toTaskId: 'b' },
      { fromTaskId: 'b', toTaskId: 'a' },
    ],
  );
  assert.ok(errors.some((error) => error.includes('环')));
});

test('依赖未完成的任务不就绪', () => {
  const tasks = [task('a', 'running'), task('b')];
  const edges = [{ fromTaskId: 'a', toTaskId: 'b' }];
  assert.deepEqual(readyTaskIds(tasks, edges), []);
  tasks[0]!.status = 'done';
  assert.deepEqual(readyTaskIds(tasks, edges), ['b']);
});

test('写域前缀重叠视为冲突', () => {
  assert.equal(writeScopeConflicts(['src/theme/**'], ['src/theme/dark/**']), true);
  assert.equal(writeScopeConflicts(['src/theme/**'], ['src/api/**']), false);
  assert.equal(writeScopeConflicts(['**'], ['src/api/**']), true);
});

test('未声明写域与任何写任务冲突', () => {
  assert.equal(writeScopeConflicts([], ['src/api/**']), true);
});

test('只读任务不参与写域互斥', () => {
  const verifier = { ...task('v', 'running', ['**']), readOnly: true };
  assert.equal(hasWriteConflict(task('i', 'queued', ['src/theme/**']), [verifier]), false);
  assert.equal(hasWriteConflict(task('i2', 'queued', ['src/theme/**']), [task('i3', 'running', ['src/theme/**'])]), true);
});
