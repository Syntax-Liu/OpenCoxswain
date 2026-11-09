import { APP_VERSION } from '../../config.js';
import { employeePack } from './pack.js';

export const apply = employeePack({
  id: 'employee.writer',
  role: 'writer',
  name: '撰写员',
  description: '撰写文档与说明，保持术语、结构与既有风格一致。',
  version: APP_VERSION,
  skills: ['文档撰写', '结构整理', '术语一致'],
  tools: ['read', 'write'],
  permissions: ['fs:read', 'fs:write'],
  readOnly: false,
  deliverableProfile: 'document',
  acceptanceDefaults: [
    {
      id: 'ac_anchors',
      type: 'rubric',
      desc: '关键结论标注来源且锚点可解析',
      evidence_required: ['anchor'],
    },
  ],
  outputSchema: 'worker-result.v1',
});
