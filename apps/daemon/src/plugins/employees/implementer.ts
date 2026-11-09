import { APP_VERSION } from '../../config.js';
import { employeePack } from './pack.js';

export const apply = employeePack({
  id: 'employee.implementer',
  role: 'implementer',
  name: '实施员',
  description: '在独立 worktree 内修改代码并跑验证，按写域提交最小改动。',
  version: APP_VERSION,
  skills: ['代码修改', '测试驱动', '小步提交'],
  tools: ['read', 'write', 'shell', 'test'],
  permissions: ['fs:read', 'fs:write', 'shell:exec', 'test:run'],
  readOnly: false,
  acceptanceDefaults: [
    { id: 'ac_human', type: 'human', desc: '用户确认改动符合目标' },
  ],
  outputSchema: 'worker-result.v1',
});
