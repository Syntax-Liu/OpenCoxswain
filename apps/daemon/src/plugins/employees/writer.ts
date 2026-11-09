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
  acceptanceDefaults: [
    { id: 'ac_rubric', type: 'rubric', desc: '文档结构与术语符合项目约定' },
    { id: 'ac_human', type: 'human', desc: '用户确认文档内容' },
  ],
  outputSchema: 'worker-result.v1',
});
