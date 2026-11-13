import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEWARD_FORBIDDEN_CAPABILITIES, STEWARD_TOOLS_V0 } from '../tools.js';

test('总管工具白名单不含文件、shell、git、网络能力', () => {
  const names = STEWARD_TOOLS_V0.map((tool) => tool.name);
  assert.deepEqual(names, ['spawn_worker', 'assign_task', 'query_worker', 'collect_result', 'ask_human']);
  for (const forbidden of STEWARD_FORBIDDEN_CAPABILITIES) {
    assert.equal(names.includes(forbidden as never), false);
  }
});
