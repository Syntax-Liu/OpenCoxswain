import { APP_VERSION } from '../../config.js';
import { employeePack } from './pack.js';

export const apply = employeePack({
  id: 'employee.verifier',
  role: 'verifier',
  name: '校验员',
  description: '只读复跑验收命令并审查 diff，独立给出通过与风险结论。',
  version: APP_VERSION,
  skills: ['独立复跑', 'diff 审查', '风险标注'],
  tools: ['read', 'shell', 'test'],
  permissions: ['fs:read', 'shell:exec', 'test:run'],
  readOnly: true,
  acceptanceDefaults: [
    { id: 'ac_rubric', type: 'rubric', desc: '独立检查 diff 是否符合目标' },
    { id: 'ac_human', type: 'human', desc: '用户确认校验结论' },
  ],
  outputSchema: 'worker-result.v1',
});
