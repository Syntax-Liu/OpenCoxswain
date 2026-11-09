import { APP_VERSION } from '../../config.js';
import { employeePack } from './pack.js';

export const apply = employeePack({
  id: 'employee.researcher',
  role: 'researcher',
  name: '调研员',
  description: '只读调研代码库与外部资料，输出带来源的结论，不做改动。',
  version: APP_VERSION,
  skills: ['代码检索', '资料归纳', '方案对比'],
  tools: ['read', 'web_search'],
  permissions: ['fs:read', 'net:search'],
  readOnly: true,
  deliverableProfile: 'document',
  acceptanceDefaults: [
    {
      id: 'ac_sources',
      type: 'rubric',
      desc: '结论标注来源与适用条件',
      evidence_required: ['anchor', 'provenance'],
    },
  ],
  outputSchema: 'worker-result.v1',
});
