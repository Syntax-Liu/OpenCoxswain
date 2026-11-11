/**
 * C（项目助理）的五个工具。
 *
 * | 工具 | 职责 | 方案出处 |
 * | --- | --- | --- |
 * | `spawn_executor` | 派一个 D 干活，立刻返回 | P1-T4 |
 * | `message_executor` | 给运行中的 D 追加指令（不打断） | P4-T2 |
 * | `list_executors` | 看本项目的 D 与在跑状态 | P1-T4 |
 * | `cancel_executor` | 取消一个 D | P1-T4 |
 * | `report_to_user` | 主动向用户汇报 | P1-T4 |
 *
 * 工具定义使用 dsh `defineTool` 的 schema DSL 形态（不是裸 JSON Schema）：
 * 参数 `required` 是逐属性注解，输出必须声明 `output.schema` + `render`。
 * 之所以用结构化类型而不是 import 上游类型：插件要能在没有宿主的单测里独立加载。
 */
import { getProject, listReports, listTurns, judgeTurn, type BaoStore } from '../store.js';
import type { TurnJudgment, TurnRow } from '../domain.js';
import type { Agent } from '../host-types.js';
import type { ExecutorRunner } from '../executor/runner.js';
import type { Gate } from '../executor/gate.js';
import { normalizeWriteScopes } from '../executor/gate.js';
import { crossCheck, judge, judgedLabel } from './judge.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(args: unknown, value: unknown): readonly unknown[];
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export interface AssistantToolDeps {
  readonly store: BaoStore;
  readonly gate: Gate;
  readonly runner: ExecutorRunner;
  readonly log: LogFn;
  /** 把一条汇报交给用户（由 index.ts 注入，落到 report 表）。 */
  readonly reportToUser: (projectId: string, body: string, needsUser: boolean) => Promise<void>;
}

function text(value: string): readonly unknown[] {
  return [{ type: 'text', text: value }];
}

/**
 * 从工具执行上下文里取调用方 C。
 *
 * 这是唯一正确的来源：并发工具调用时不能靠"插件级当前 Agent"缓存，
 * 否则 A 项目的执行者会被挂到 B 的 C 下面（M0 踩过的坑，保留此约束）。
 */
function callerOf(exec: unknown): Agent {
  const agent = (exec as { agent?: Agent } | undefined)?.agent;
  if (!agent) {
    throw new Error(
      '调用失败：工具执行上下文里没有调用方 Agent（项目助理 C）。' +
        '请从项目助理会话内调用，而不是直接调用插件内部方法。',
    );
  }
  return agent;
}

/** 从 C 的会话反查它负责哪个项目。 */
function projectOfCaller(store: BaoStore, agent: Agent): string | undefined {
  const sessionId = agent.session?.id ?? agent.id;
  if (!sessionId) return undefined;
  for (const [, project] of store.projects.entries()) {
    if (project.assistantSessionId === sessionId) return project.id;
  }
  return undefined;
}

export function buildAssistantTools(deps: AssistantToolDeps): ToolDefinitionLike[] {
  return [
    spawnExecutor(deps),
    messageExecutor(deps),
    listExecutorsTool(deps),
    cancelExecutor(deps),
    reportToUserTool(deps),
  ];
}

// ---------------------------------------------------------------------------
// spawn_executor
// ---------------------------------------------------------------------------

function spawnExecutor({ store, runner, gate, log }: AssistantToolDeps): ToolDefinitionLike {
  return {
    name: 'spawn_executor',
    description:
      '派一个执行者（D）去干一件确定的活，**立刻返回**，不等待结果。' +
      '可以连续调用多次让多个 D 并行推进。' +
      '每个 D 必须声明 writeScope（它可能要改的路径前缀），写域相交的 D 会被自动串行。',
    parameters: {
      label: {
        type: 'string',
        required: true,
        description: '一句话说清这个执行者要做什么，用于汇报时标识它',
      },
      goal: {
        type: 'string',
        required: true,
        description: '完整目标与验收标准，要能让执行者独立理解（它看不到你和用户的对话）',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description:
          '这个 D 可能改动的路径前缀（相对项目根，如 ["src/auth"]）。' +
          '声明不了就留空，但留空的 D 会与所有写任务串行。',
      },
      judged: {
        type: 'string',
        enum: ['new', 'parallel', 'conflict'],
        description:
          '你对"这条需求与在跑任务的关系"的判定：new=全新 / parallel=可并行 / conflict=冲突。' +
          '冲突时你应当先调整或取消现有 D，而不是直接派新的。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          executorId: { type: 'string' },
          label: { type: 'string' },
          status: { type: 'string' },
          admitted: { type: 'boolean' },
          queueReason: { type: 'string' },
          gate: {
            type: 'object',
            additionalProperties: false,
            properties: {
              running: { type: 'integer' },
              queued: { type: 'integer' },
              limit: { type: 'integer' },
            },
          },
          judgmentNote: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as {
          executorId: string;
          label: string;
          status: string;
          admitted: boolean;
          queueReason: string;
          gate: { running: number; queued: number; limit: number };
          judgmentNote: string;
        };
        const queue = v.admitted ? '' : `（排队中：${v.queueReason}）`;
        const lines = [
          `已派出执行者「${v.label}」（${v.executorId}），状态 ${v.status}${queue}。`,
          `当前运行 ${v.gate.running}/${v.gate.limit}，排队 ${v.gate.queued}。`,
        ];
        if (v.judgmentNote) lines.push('', v.judgmentNote);
        return text(lines.join('\n'));
      },
    },
    async execute(rawArgs, rawExec) {
      const args = rawArgs as {
        label: string;
        goal: string;
        writeScope?: string[];
        judged?: TurnJudgment;
      };
      const caller = callerOf(rawExec);
      const projectId = projectOfCaller(store, caller);
      if (!projectId) {
        throw new Error(
          '无法确定你负责哪个项目：当前会话不是任何项目的项目助理。' +
            '请先在对应项目里打开项目助理会话。',
        );
      }
      if (getProject(store, projectId) === undefined) {
        throw new Error(`项目 ${projectId} 不存在`);
      }

      const scopes = normalizeWriteScopes(args.writeScope);

      // 冲突判定：C 声明了就用 C 的（它更懂上下文），但要把矛盾如实告诉它。
      const active = runner.list(projectId).filter((e) => e.status === 'running' || e.status === 'starting');
      const inference = judge({ writeScopes: scopes, active });
      const judged: TurnJudgment = args.judged ?? inference.judged;
      let judgmentNote = '';
      if (args.judged) {
        const check = crossCheck(args.judged, { writeScopes: scopes, active });
        if (!check.consistent && check.note) judgmentNote = check.note;
      } else {
        judgmentNote = `（我按写域判断为「${judgedLabel(judged)}」：${inference.reason}）`;
      }

      const outcome = await runner.start(
        { projectId, label: args.label, goal: args.goal, writeScope: scopes },
        caller,
      );

      // 留痕：这条需求被判定成什么，让"C 判错了"可审计（方案 §5.2）。
      const { createTurn } = await import('../store.js');
      await createTurn(store, {
        projectId,
        role: 'assistant',
        source: 'assistant',
        text: `${args.label}：${args.goal}`,
        executorId: outcome.executor.id,
        judged,
      });

      log('info', `C 派活 ${outcome.executor.id}（判定 ${judged}）`);
      return {
        executorId: outcome.executor.id,
        label: outcome.executor.label,
        status: outcome.executor.status,
        admitted: outcome.admitted,
        queueReason: outcome.queueReason,
        gate: gate.stats(),
        judgmentNote,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// message_executor
// ---------------------------------------------------------------------------

function messageExecutor({ store, runner }: AssistantToolDeps): ToolDefinitionLike {
  return {
    name: 'message_executor',
    description:
      '给一个仍在运行/排队的执行者追加指令。**不打断**它当前这轮，指令排到下一个边界。' +
      '用于"你自己先推进"：发现 D 走错方向时改它的指令，而不是直接取消重来。',
    parameters: {
      executorId: { type: 'string', required: true, description: '目标执行者 id' },
      message: { type: 'string', required: true, description: '要追加的指令' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => text((value as { message: string }).message),
    },
    async execute(rawArgs, rawExec) {
      const args = rawArgs as { executorId: string; message: string };
      const caller = callerOf(rawExec);
      const row = runner.list(projectOfCaller(store, caller) ?? '').find((e) => e.id === args.executorId);
      if (!row) {
        return { ok: false, message: `执行者 ${args.executorId} 不属于你负责的项目` };
      }
      return runner.message(args.executorId, caller, args.message);
    },
  };
}

// ---------------------------------------------------------------------------
// list_executors
// ---------------------------------------------------------------------------

function listExecutorsTool({ store, runner }: AssistantToolDeps): ToolDefinitionLike {
  return {
    name: 'list_executors',
    description:
      '列出你负责的项目里的执行者及其状态。用来回答"进展如何"——**先查再答，不要凭记忆编**。',
    parameters: {
      status: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['starting', 'running', 'idle', 'done', 'failed', 'cancelled'],
        },
        description: '只看这些状态',
      },
      limit: { type: 'integer', description: '最多返回多少条，缺省 50' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          executors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                executorId: { type: 'string' },
                label: { type: 'string' },
                status: { type: 'string' },
                writeScope: { type: 'string' },
                summary: { type: 'string' },
                blockedReason: { type: 'string' },
                resumable: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          total: number;
          executors: Array<{
            executorId: string;
            label: string;
            status: string;
            writeScope: string;
            summary: string;
            blockedReason: string;
            resumable: boolean;
          }>;
        };
        if (!v.total) return text('本项目还没有执行者。');
        const lines = v.executors.map((e) => {
          const extra = e.blockedReason
            ? ` — 卡点：${firstLine(e.blockedReason)}`
            : e.summary
              ? ` — ${firstLine(e.summary)}`
              : '';
          const scope = e.writeScope ? ` [写域 ${e.writeScope}]` : ' [未声明写域]';
          const resume = e.resumable ? '（可追问）' : '';
          return `- [${e.status}] ${e.label}（${e.executorId}）${scope}${resume}${extra}`;
        });
        return text(`共 ${v.total} 条：\n${lines.join('\n')}`);
      },
    },
    async execute(rawArgs, rawExec) {
      const args = rawArgs as { status?: string[]; limit?: number };
      const caller = callerOf(rawExec);
      const projectId = projectOfCaller(store, caller);
      if (!projectId) {
        throw new Error('无法确定你负责哪个项目：当前会话不是任何项目的项目助理');
      }
      const rows = runner.list(projectId);
      const filtered = args.status?.length
        ? rows.filter((e) => args.status!.includes(e.status))
        : rows;
      const limit = args.limit && args.limit > 0 ? args.limit : 50;
      return {
        total: filtered.length,
        executors: filtered.slice(-limit).map((e) => ({
          executorId: e.id,
          label: e.label,
          status: e.status,
          writeScope: e.writeScope,
          summary: e.summary ?? '',
          blockedReason: e.blockedReason ?? '',
          resumable: e.resumable === 1,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// cancel_executor
// ---------------------------------------------------------------------------

function cancelExecutor({ store, runner }: AssistantToolDeps): ToolDefinitionLike {
  return {
    name: 'cancel_executor',
    description:
      '取消一个执行者。已处于终态的直接告知无需取消。' +
      '用于"冲突按新需求"：确实改不了现有 D 的指令时取消它，再按新需求重开。',
    parameters: {
      executorId: { type: 'string', required: true, description: '要取消的执行者 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => text((value as { message: string }).message),
    },
    async execute(rawArgs, rawExec) {
      const args = rawArgs as { executorId: string };
      const caller = callerOf(rawExec);
      const projectId = projectOfCaller(store, caller);
      const owned = projectId
        ? runner.list(projectId).some((e) => e.id === args.executorId)
        : false;
      if (!owned) {
        return { ok: false, message: `执行者 ${args.executorId} 不属于你负责的项目` };
      }
      return runner.cancel(args.executorId);
    },
  };
}

// ---------------------------------------------------------------------------
// report_to_user
// ---------------------------------------------------------------------------

function reportToUserTool({ store, reportToUser }: AssistantToolDeps): ToolDefinitionLike {
  return {
    name: 'report_to_user',
    description:
      '主动向用户汇报一件事（进度、卡点或结论）。' +
      '执行者结算后你应当**立刻**汇报该结果，不要等其它执行者（谁先完成先报谁）。',
    parameters: {
      body: { type: 'string', required: true, description: '要汇报给用户的内容' },
      needsUser: {
        type: 'boolean',
        description: '是否需要用户拍板。默认 false',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => text((value as { message: string }).message),
    },
    async execute(rawArgs, rawExec) {
      const args = rawArgs as { body: string; needsUser?: boolean };
      const caller = callerOf(rawExec);
      const projectId = projectOfCaller(store, caller);
      if (!projectId) {
        throw new Error('无法确定你负责哪个项目：当前会话不是任何项目的项目助理');
      }
      await reportToUser(projectId, args.body, args.needsUser === true);
      return { ok: true, message: '已汇报给用户' };
    },
  };
}

function firstLine(value: string): string {
  const line = value.split('\n').find((l) => l.trim());
  return line ? line.trim() : value;
}

// 供其它模块复用的只读查询（B 的汇总会用到）。
export function recentTurns(store: BaoStore, projectId: string, limit = 10): TurnRow[] {
  return listTurns(store, projectId, limit);
}

export function recentReports(store: BaoStore, projectId: string) {
  return listReports(store, projectId).slice(-10);
}

export { judgeTurn };
