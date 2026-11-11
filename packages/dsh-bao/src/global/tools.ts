/**
 * B（全局助理）的三个工具。
 *
 * 方案 §7.1 D1（已拍板）：B 的能力清单就是这三条，多一条都不给。
 *
 * | B 可以 | B 不可以 |
 * | --- | --- |
 * | `list_projects`：列出项目及其 C 的状态 | 自己派 D（一律禁止） |
 * | `find_project`：判断用户的话属于哪个项目，**必须给出依据** | 自己改代码、自己跑构建 |
 * | `handoff_to_assistant`：把用户**原话原样**转交给目标 C | 代 C 汇报"已完成" |
 *
 * 三条工程后果（§7.1）：
 * 1. 转交的是原话，不是 B 的复述。
 * 2. B 必须回报转交结果，失败如实说。
 * 3. B 不能"猜项目"硬转，依据不足时反问。
 */
import type { ProjectRow } from '../domain.js';
import { getProject, listExecutors, listProjects, type BaoStore } from '../store.js';
import type { Agent } from '../host-types.js';
import { userMessage } from '../host-types.js';
import type { ToolDefinitionLike, LogFn } from '../assistant/tools.js';

export interface GlobalToolDeps {
  readonly store: BaoStore;
  readonly log: LogFn;
  /** 取活着的 C（取不到是常态，必须如实回报）。 */
  readonly assistantOf: (projectId: string) => Agent | undefined;
}

function text(value: string): readonly unknown[] {
  return [{ type: 'text', text: value }];
}

export function buildGlobalTools(deps: GlobalToolDeps): ToolDefinitionLike[] {
  return [listProjectsTool(deps), findProjectTool(deps), handoffToAssistant(deps)];
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

function listProjectsTool({ store, assistantOf }: GlobalToolDeps): ToolDefinitionLike {
  return {
    name: 'list_projects',
    description:
      '列出所有项目及其项目助理（C）的状态、在跑的执行者数量与最近活动。' +
      '用于回答"现在都在干什么"，以及判断用户说的话该找哪个 C。',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少条，缺省 50' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                projectId: { type: 'string' },
                name: { type: 'string' },
                rootPath: { type: 'string' },
                assistantLoaded: { type: 'boolean' },
                runningExecutors: { type: 'integer' },
                lastActivity: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          total: number;
          projects: Array<{
            projectId: string;
            name: string;
            rootPath: string;
            assistantLoaded: boolean;
            runningExecutors: number;
            lastActivity: string;
          }>;
        };
        if (!v.total) return text('还没有任何项目。');
        const lines = v.projects.map((p) => {
          const c = p.assistantLoaded ? 'C 在线' : 'C 未加载';
          const run = p.runningExecutors > 0 ? `，在跑 ${p.runningExecutors} 个执行者` : '';
          return `- ${p.name}（${p.projectId}）${p.rootPath} — ${c}${run}`;
        });
        return text(`共 ${v.total} 个项目：\n${lines.join('\n')}`);
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { limit?: number };
      const limit = args.limit && args.limit > 0 ? args.limit : 50;
      const projects = listProjects(store).slice(0, limit);
      return {
        total: listProjects(store).length,
        projects: projects.map((p) => ({
          projectId: p.id,
          name: p.name,
          rootPath: p.rootPath,
          assistantLoaded: assistantOf(p.id) !== undefined,
          runningExecutors: listExecutors(store, {
            projectId: p.id,
            status: ['starting', 'running'],
          }).length,
          lastActivity: p.updatedAt,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// find_project —— 必须给出依据
// ---------------------------------------------------------------------------

interface Candidate {
  readonly project: ProjectRow;
  readonly score: number;
  readonly reasons: string[];
}

/**
 * 规则打分。**不做语义模型推断，不建单、不改项目状态**（方案 §6 P2-T2）。
 *
 * 打分来源：项目名命中、路径命中、该项目最近执行者的标题/目标命中。
 */
function scoreProjects(store: BaoStore, query: string): Candidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const candidates: Candidate[] = [];

  for (const project of listProjects(store)) {
    const reasons: string[] = [];
    let score = 0;

    const name = project.name.toLowerCase();
    if (name && needle.includes(name)) {
      score += 3;
      reasons.push(`项目名「${project.name}」出现在你的话里`);
    }

    const path = project.rootPath.toLowerCase();
    const segments = path.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length >= 2 && needle.includes(segment)) {
        score += 2;
        reasons.push(`路径片段「${segment}」出现在你的话里`);
        break;
      }
    }

    // 最近任务命中
    for (const executor of listExecutors(store, { projectId: project.id }).slice(-20)) {
      const haystack = `${executor.label} ${executor.goal}`.toLowerCase();
      const tokens = tokenize(needle);
      const hit = tokens.filter((t) => haystack.includes(t));
      if (hit.length >= 2) {
        score += hit.length;
        reasons.push(`最近的执行者命中关键词：${hit.slice(0, 3).join('、')}`);
        break;
      }
    }

    if (score > 0) candidates.push({ project, score, reasons: reasons.slice(0, 3) });
  }

  candidates.sort((a, b) => b.score - a.score || a.project.createdAt.localeCompare(b.project.createdAt));
  return candidates;
}

/** 极简切词：中文按二元组，英文按空白与标点。 */
function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 2 <= word.length; i += 1) out.add(word.slice(i, i + 2));
    } else if (word.length >= 2) {
      out.add(word);
    }
  }
  return [...out];
}

function findProjectTool({ store }: GlobalToolDeps): ToolDefinitionLike {
  return {
    name: 'find_project',
    description:
      '判断用户这句话属于哪个项目。**必须给出依据**；依据为空或存在多个等分候选时，' +
      '你应当反问你用户，而不是挑一个硬转。本工具不建单、不改任何状态。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '用户的原话（不要改写、不要摘要）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision: { type: 'string', description: 'unique / ambiguous / none' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                projectId: { type: 'string' },
                name: { type: 'string' },
                score: { type: 'number' },
                reasons: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as {
          decision: string;
          candidates: Array<{ name: string; projectId: string; score: number; reasons: string[] }>;
          hint: string;
        };
        if (v.decision === 'none') {
          return text(`没有项目命中这句话。${v.hint}`);
        }
        const lines = v.candidates.map(
          (c) => `- ${c.name}（${c.projectId}）分数 ${c.score}：${c.reasons.join('；')}`,
        );
        return text(
          `${v.decision === 'unique' ? '唯一候选' : '候选不唯一'}：\n${lines.join('\n')}\n${v.hint}`,
        );
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { query: string };
      const scored = scoreProjects(store, args.query).slice(0, 3);
      if (scored.length === 0) {
        return {
          decision: 'none' as const,
          candidates: [],
          hint: '请反问用户是哪个项目，不要猜测。',
        };
      }
      const top = scored[0]!;
      const tied = scored.filter((c) => c.score === top.score);
      if (tied.length > 1) {
        return {
          decision: 'ambiguous' as const,
          candidates: scored.map(toCandidate),
          hint: `有 ${tied.length} 个项目等分，请反问用户而不是二选一硬转。`,
        };
      }
      return {
        decision: 'unique' as const,
        candidates: scored.map(toCandidate),
        hint: `建议转交给 ${top.project.name} 的项目助理（${top.project.id}）。`,
      };
    },
  };
}

function toCandidate(c: Candidate) {
  return { projectId: c.project.id, name: c.project.name, score: c.score, reasons: c.reasons };
}

// ---------------------------------------------------------------------------
// handoff_to_assistant —— 转交原话
// ---------------------------------------------------------------------------

function handoffToAssistant({ store, assistantOf, log }: GlobalToolDeps): ToolDefinitionLike {
  return {
    name: 'handoff_to_assistant',
    description:
      '把用户的**原话原样**转交给目标项目的项目助理（C）。' +
      '不做摘要、不做补充、不代 B 理解。转交结果必须如实回报给用户。' +
      '你绝不能自己派执行者或代 C 汇报"已完成"。',
    parameters: {
      projectId: { type: 'string', required: true, description: '目标项目 id' },
      userText: {
        type: 'string',
        required: true,
        description: '用户的原话，逐字复制，不允许改写或摘要',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          project: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok: boolean; project: string; reason: string };
        return text(v.ok ? `已把原话转交给「${v.project}」的项目助理。` : `转交失败：${v.reason}`);
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { projectId: string; userText: string };

      // 1) 校验项目存在且有 C。
      const project = getProject(store, args.projectId);
      if (!project) {
        return { ok: false, project: '', reason: `项目 ${args.projectId} 不存在` };
      }
      if (!project.assistantSessionId) {
        return {
          ok: false,
          project: project.name,
          reason: `${project.name} 还没有项目助理，请先在该项目里打开一次`,
        };
      }
      if (!args.userText.trim()) {
        return { ok: false, project: project.name, reason: '要转交的原话为空' };
      }

      // 2) 取活的 C。取不到说明插件重启过、C 尚未恢复。
      const assistant = assistantOf(project.id);
      if (!assistant) {
        return {
          ok: false,
          project: project.name,
          reason: `${project.name} 的项目助理当前未加载，请打开该项目后再试`,
        };
      }
      if (typeof assistant.followup !== 'function') {
        return {
          ok: false,
          project: project.name,
          reason: `${project.name} 的项目助理不支持接收消息（宿主未提供 followup）`,
        };
      }

      // 3) 原话投递：不加工、不摘要、不补充 B 自己的理解。
      //    followup 而不是 steer —— 转交不能被当成插队指令打断 C 正在进行的工作。
      try {
        assistant.followup(
          userMessage(args.userText, { kind: 'global-assistant-handoff', projectId: project.id }),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log('warn', `转交给项目 ${project.name} 的 C 失败：${reason}`);
        return { ok: false, project: project.name, reason: `转交失败：${reason}` };
      }

      log('info', `B 把用户原话转交给 ${project.name} 的 C`);
      // 不产生"第二套状态"：B 只回报"已转交"，真相在 C 那边（§7.3 第 3 点）。
      return { ok: true, project: project.name, reason: '' };
    },
  };
}
