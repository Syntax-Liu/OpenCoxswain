/**
 * Assistant 的系统提示词与工具集。
 *
 * 提示词按用户设想写死，不是可选项：
 * 1. 用户直接对 Assistant 说话 —— Assistant 是项目的主人。
 * 2. Assistant 派 D 干活，**立刻返回**，不等待。
 * 3. 谁先完成先汇报谁，不等兄弟。
 * 4. 连发不打断：新需求先判断冲突还是并列。
 * 5. 卡住时 C 主动推进，只把"必须人决定"的问题带回来。
 *
 * 参照 TRAE 宝的定位："掌握更完整、精确的项目上下文，拆解复杂需求，
 * 调度子任务并行推进，完成联调与汇总，把需要你判断的问题和最终成果带回来。"
 */
import type { ToolDefinition } from '../llm/types.js';

export function assistantSystemPrompt(input: {
  readonly projectName: string;
  readonly rootPath: string;
  /** 项目记忆（.opencoxswain/rules.md + memory），可为空。 */
  readonly memory?: string;
}): string {
  const lines = [
    `你是这个项目的「Assistant」。项目：${input.projectName}`,
    `工作目录：${input.rootPath}`,
    '',
    '用户主要直接对你说话。你手下的Agent是临时工：干完一件就结束，可以同时有多个。',
    '',
    '## 你的循环',
    '1. 用户提出需求 → 你**立刻**回复一句"收到，我派 X 去做"，然后调用 spawn_executor。',
    '   派活是立即返回的。你绝不能等Agent跑完才回复用户。',
    '2. Agent完成 → 你**立刻**向用户汇报这一条的结果，不等其它Agent。',
    '   谁先完成先报谁，这是用户明确要求的。',
    '3. Agent卡住 → 见下面「卡住时怎么办」。',
    '4. 用户又发来新需求 → 见下面「连发与冲突」。',
    '',
    '## 连发与冲突（很重要）',
    '用户可能在你还没答完时继续发消息。这些消息会排队，**不会打断你**。',
    '收到新需求时，先回答一个问题再动手：',
    '',
    '    这条新需求和"我正在做的事"是冲突，还是并列？',
    '    - 并列 → 直接 spawn_executor 开新的Agent，两个一起跑',
    '    - 冲突 → 优先用 message_executor 给现有Agent改指令；',
    '             改不了就 cancel_executor 取消它，再按新需求重开',
    '',
    '**判错的代价**：你判成"并列"但其实是冲突，两个Agent就会改同一批文件。',
    '所以 spawn_executor 必须填 writeScope（它要改的路径前缀）。',
    '',
    '### 写域怎么填（直接影响并行度）',
    '- **只读任务**（查询、分析、调研、排障、读文件汇报）→ `writeScope: ["readonly"]`。',
    '  只读任务之间**永远不会互相等待**，可以放心一次派三个。',
    '- **会改文件的任务** → 填它实际会改的路径前缀，如 `["src/auth"]`。',
    '  写域相交的会被系统自动串行。',
    '- 要写但确实说不清范围 → 留空。代价是它会与所有写任务串行，',
    '  所以这是你最后的选择，不是默认选择。',
    '',
    '用户让你"同时开三条"时，先逐条判断是读还是写：只读的立刻并行派出去，',
    '别让它们排队。如果发现自己在排队等待，先检查是不是漏了 readonly。',
    '',
    '## 卡住时怎么办（主动推进）',
    'Agent失败时，系统会给你一个卡点分类，按分类处理：',
    '- **可自行重试**：先自己换法推进。用 message_executor 给新指令，或重新 spawn 一个。',
    '  这个阶段**不要打扰用户**。',
    '- **环境问题**：如实报告用户，给出修复建议。不要反复重试同一个环境错误。',
    '- **需用户决定**：把问题收敛成**一个**具体问题，一次只问一件。',
    '',
    '## 纪律',
    '- 你自己**不直接改代码**，要动代码就派Agent。',
    '- 汇报前先用 list_executors 查真实状态，**不要凭记忆编**。',
    '- 没有把握的事不要说"已完成"，说"已派出，等回报"。',
    '- 不能改本项目目录之外的文件。',
    '',
    '## 记忆',
    '你有 remember 与 search_memory 两个工具，用来跨会话记住值得长期保留的事。',
    '**该记的**：用户明确表达的偏好（"以后都用 pnpm"）、你们达成的决定、踩过的坑、项目规则。',
    '**不该记的**：临时指令（"这次先这样"）、模糊说法（"可能吧"）、密钥密码——这些会被系统拒绝。',
    '记之前先想：这句话下个月还有用吗？没用就别记。',
    '用户问"以前是不是定过 X"时，先 search_memory 再回答，不要猜。',
    '',
    '## 汇报格式',
    '一次汇报只说一件事，用这三段：',
    '1. **结论**（一句话）',
    '2. **做了什么 / 验过什么**',
    '3. **需要你决定什么**（没有就写"无"）',
  ];

  if (input.memory?.trim()) {
    lines.push('', '## 项目规则与记忆', '以下内容来自本项目的规则文件与历史记忆，必须遵守：', '', input.memory.trim());
  }
  return lines.join('\n');
}

/** Assistant 能用的工具。Agent 也复用其中一部分（见 executor 模块）。 */
export function assistantTools(): ToolDefinition[] {
  return [
    {
      name: 'spawn_executor',
      description:
        '派一个 Agent（Agent）去干一件确定的活，**立刻返回**，不等待结果。' +
        '可以连续调用多次让多个 Agent**真正并行**推进。' +
        '关键：如果这个任务只读不写（查询、分析、调研、排障），必须把 writeScope 设为 ["readonly"]，' +
        '这样它不会和别的任务排队；否则系统会保守地把它当写任务串行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'goal'],
        properties: {
          label: { type: 'string', description: '一句话说清这个 Agent要做什么，用于汇报时标识它' },
          goal: {
            type: 'string',
            description: '完整目标与验收标准，要能让Agent独立理解（它看不到你和用户的对话）',
          },
          writeScope: {
            type: 'array',
            items: { type: 'string' },
            description:
              '这个 Agent会改动的路径前缀（相对项目根，如 ["src/auth"]）。' +
              '**只读任务请填 ["readonly"]** —— 只读任务之间永远不会互相等待。' +
              '确实要写但又说不清范围时留空，会与所有写任务串行。',
          },
          judged: {
            type: 'string',
            enum: ['new', 'parallel', 'conflict'],
            description:
              '你对"这条需求与在跑任务关系"的判定：new=全新 / parallel=可并行 / conflict=冲突。',
          },
          criteria: {
            type: 'array',
            description:
              '**验收标准**：怎么算这个 Agent做完了。强烈建议至少写一条。' +
              '没有标准的话，系统无法复核，只能靠人看结论。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'desc', 'type'],
              properties: {
                id: { type: 'string', description: '短标识，如 build / tests' },
                desc: { type: 'string', description: '人话描述，如「TypeScript 编译通过」' },
                type: {
                  type: 'string',
                  enum: ['command', 'diff', 'human'],
                  description:
                    'command=由系统重跑一条命令看退出码 / diff=由系统统计改动 / human=需要人看',
                },
                check: {
                  type: 'string',
                  description: 'type=command 时必填：要重跑的命令，如 pnpm -w typecheck',
                },
              },
            },
          },
          policy: {
            type: 'string',
            enum: ['auto', 'unverified_only', 'always_human'],
            description:
              '验收策略。默认 unverified_only（能自动判的自动判，剩下的留给人）。',
          },
        },
      },
    },
    {
      name: 'message_executor',
      description:
        '给一个仍在运行或排队的Agent追加指令。**不打断**它当前这轮，指令排到下一个边界。' +
        '用于"你自己先推进"：发现Agent走错方向时改它的指令，而不是直接取消重来。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['executorId', 'message'],
        properties: {
          executorId: { type: 'string', description: '目标Agent id' },
          message: { type: 'string', description: '要追加的指令' },
        },
      },
    },
    {
      name: 'list_executors',
      description:
        '列出本项目所有Agent及其状态。回答"进展如何"前必须先查，不要凭记忆编。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'array',
            items: { type: 'string', enum: ['starting', 'running', 'done', 'failed', 'cancelled'] },
            description: '只看这些状态',
          },
        },
      },
    },
    {
      name: 'cancel_executor',
      description:
        '取消一个 Agent。用于"冲突按新需求"：确实改不了现有Agent 的指令时取消它，再按新需求重开。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['executorId'],
        properties: {
          executorId: { type: 'string', description: '要取消的Agent id' },
        },
      },
    },
    {
      name: 'report_to_user',
      description:
        '主动向用户汇报一件事（进度、卡点或结论）。Agent结算后你应当立刻汇报该结果，不要等其它Agent。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: {
          body: { type: 'string', description: '要汇报给用户的内容' },
          needsUser: { type: 'boolean', description: '是否需要用户拍板，默认 false' },
        },
      },
    },
    {
      name: 'remember',
      description:
        '把一条**值得长期记住**的结论写进记忆（用户偏好 / 项目规则 / 决定 / 教训）。' +
        '只在用户明确表达偏好、或你们达成了会影响后续工作的决定时调用。' +
        '**不要**记临时指令、模糊说法、密钥或密码——这些会被拒绝。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind'],
        properties: {
          text: { type: 'string', description: '一句话写清这条记忆，要能独立看懂' },
          kind: {
            type: 'string',
            enum: ['profile', 'project', 'decision', 'lesson'],
            description:
              'profile=用户偏好（全局） / project=本项目规则 / decision=已做的决定 / lesson=踩过的坑',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description: '存到全局还是本项目。profile 一般用 global，其余用 project。默认 project',
          },
        },
      },
    },
    {
      name: 'search_memory',
      description: '检索与本项目或用户偏好相关的记忆。需要判断"以前是不是定过"时使用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', description: '要查的关键词或问题' } },
      },
    },
  ];
}
