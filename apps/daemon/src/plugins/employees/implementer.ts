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
  deliverableProfile: 'code',
  acceptanceDefaults: [
    { id: 'ac_diff', type: 'diff', desc: '改动与产物内容一致' },
  ],
  outputSchema: 'worker-result.v1',
});
