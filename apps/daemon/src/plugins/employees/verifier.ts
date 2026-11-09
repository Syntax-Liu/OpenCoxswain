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
  capabilities: ['fs.read', 'proc.spawn'],
  readOnly: true,
  deliverableProfile: 'code',
  acceptanceDefaults: [
    {
      id: 'ac_review',
      type: 'rubric',
      desc: '独立复核验收命令输出',
      evidence_required: ['command_output'],
    },
  ],
  outputSchema: 'worker-result.v1',
});
