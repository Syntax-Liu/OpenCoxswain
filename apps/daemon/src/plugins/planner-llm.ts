import type {
  PlanResult,
  PlannerService,
  PluginContext,
  SecretSource,
} from '@opencoxswain/plugin-api';
import type {
  AcceptanceCriterion,
  CreatePlanRequest,
  Deliverable,
  Project,
  RoleName,
  SubtaskDraft,
} from '@opencoxswain/shared';
import { Planner } from '../planner.js';

const ROLES: ReadonlySet<string> = new Set<RoleName>([
  'implementer',
  'verifier',
  'researcher',
  'writer',
]);

const ACCEPTANCE_TYPES: ReadonlySet<string> = new Set([
  'command',
  'diff',
  'rubric',
  'human',
]);

const DELIVERABLE_TYPES: ReadonlySet<string> = new Set(['diff', 'file', 'report', 'link']);

const SYSTEM_PROMPT = [
  '你是 OpenCoxswain 的总管 Planner。你只输出 JSON，不输出任何解释。',
  '把用户目标拆成 2-5 个可独立执行、带依赖关系的子任务。每个子任务由一名 AI 员工在独立 git worktree 中执行。',
  '角色只能是：implementer（实施，可写文件）、verifier（校验，只读）、researcher（调研，只读）、writer（写作，可写文件）。',
  '校验类子任务必须通过 dependsOn 指向实施任务（0 基索引）。',
  '每个子任务的 acceptance 至少包含一个 human 类型；可自动验证时优先给 command（带 check 命令）或 diff（依赖 writeScope）。',
  'writeScope 使用仓库相对路径或目录前缀；verifier / researcher 留空数组。',
].join('\n');

interface LlmPlannerOptions {
  engine: Planner;
  resolveKey: () => Promise<{ key: string; source: SecretSource }>;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  notify: (type: string, payload: unknown) => void;
}

export class LlmPlanner implements PlannerService {
  constructor(private readonly options: LlmPlannerOptions) {}

  async plan(project: Project, request: CreatePlanRequest): Promise<PlanResult> {
    const hasDrafts = (request.subtasks?.length ?? 0) > 0;
    if (hasDrafts) {
      return this.options.engine.plan(project, request);
    }

    const { key, source } = await this.options.resolveKey();
    if (!key) {
      this.options.notify('planner.fallback', {
        reason: '未配置 LLM Key，使用静态拆分',
        source: 'none',
      });
      return this.options.engine.plan(project, request);
    }

    try {
      const subtasks = await this.draft(request, key);
      this.options.notify('planner.llm.used', {
        model: this.options.model,
        subtasks: subtasks.length,
        keySource: source,
      });
      return this.options.engine.plan(project, { ...request, subtasks });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.notify('planner.fallback', { reason });
      return this.options.engine.plan(project, request);
    }
  }

  private async draft(request: CreatePlanRequest, apiKey: string): Promise<SubtaskDraft[]> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: this.userPrompt(request) },
        ],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM 请求失败：HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('LLM 返回为空');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      throw new Error('LLM 返回不是合法 JSON');
    }

    const raw = (parsed as { subtasks?: unknown }).subtasks;
    if (!Array.isArray(raw)) throw new Error('LLM 返回缺少 subtasks 数组');
    return normalizeSubtasks(raw);
  }

  private userPrompt(request: CreatePlanRequest): string {
    const budget = request.budget;
    return [
      `目标：${request.goal}`,
      budget
        ? `预算：${[
            budget.usd !== undefined ? `$${budget.usd}` : null,
            budget.tokens !== undefined ? `${budget.tokens} tokens` : null,
            budget.minutes !== undefined ? `${budget.minutes} 分钟` : null,
          ]
            .filter(Boolean)
            .join(' / ')}`
        : null,
      request.acceptanceCommand ? `验收命令：${request.acceptanceCommand}` : null,
      '',
      '输出 JSON，结构如下：',
      '{"subtasks":[{"title":"实施：…","goal":"…","role":"implementer","dependsOn":[],"writeScope":["src/"],"acceptance":[{"id":"ac1","type":"command","desc":"测试通过","check":"npm test"},{"id":"ac_human","type":"human","desc":"用户验收"}],"deliverables":[{"type":"diff","scope":"src/"}]}]}',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1]! : trimmed;
}

function normalizeSubtasks(raw: unknown[]): SubtaskDraft[] {
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`子任务 ${index} 不是对象`);
    }
    const value = item as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    const goal = typeof value.goal === 'string' ? value.goal.trim() : '';
    const role = typeof value.role === 'string' ? value.role.trim() : '';
    if (!title || !goal) throw new Error(`子任务 ${index} 缺少 title 或 goal`);
    if (!ROLES.has(role)) throw new Error(`子任务 ${index} 的角色非法：${role}`);

    const draft: SubtaskDraft = {
      title,
      goal,
      role: role as RoleName,
      dependsOn: Array.isArray(value.dependsOn)
        ? value.dependsOn.filter((entry): entry is number => Number.isInteger(entry))
        : [],
    };

    if (Array.isArray(value.writeScope)) {
      draft.writeScope = value.writeScope.filter(
        (entry): entry is string => typeof entry === 'string',
      );
    }
    if (Array.isArray(value.constraints)) {
      draft.constraints = value.constraints.filter(
        (entry): entry is string => typeof entry === 'string',
      );
    }
    if (Array.isArray(value.acceptance)) {
      draft.acceptance = value.acceptance
        .map((entry, position) => normalizeAcceptance(entry, position))
        .filter((entry): entry is AcceptanceCriterion => entry !== null);
    }
    if (Array.isArray(value.deliverables)) {
      draft.deliverables = value.deliverables
        .map(normalizeDeliverable)
        .filter((entry): entry is Deliverable => entry !== null);
    }

    return draft;
  });
}

function normalizeAcceptance(value: unknown, index: number): AcceptanceCriterion | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const type = typeof item.type === 'string' ? item.type : '';
  const desc = typeof item.desc === 'string' ? item.desc.trim() : '';
  if (!ACCEPTANCE_TYPES.has(type) || !desc) return null;
  const check = typeof item.check === 'string' ? item.check.trim() : '';
  if (type === 'command' && !check) return null;
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ac${index + 1}`,
    type: type as AcceptanceCriterion['type'],
    desc,
    ...(check ? { check } : {}),
  };
}

function normalizeDeliverable(value: unknown): Deliverable | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const type = typeof item.type === 'string' ? item.type : '';
  if (!DELIVERABLE_TYPES.has(type)) return null;
  const scope = typeof item.scope === 'string' ? item.scope.trim() : '';
  return { type: type as Deliverable['type'], ...(scope ? { scope } : {}) };
}

export async function apply(ctx: PluginContext): Promise<void> {
  const config = ctx.config;
  const employees = ctx.service('employees');
  const engine = new Planner({
    runtime: config.defaultRuntime,
    model: config.defaultModel,
    employees,
  });
  const secrets = ctx.service('secrets');
  const baseUrl = (
    process.env.OPENCOXSWAIN_LLM_BASE_URL ?? 'https://api.deepseek.com/v1'
  ).trim();
  const model = (process.env.OPENCOXSWAIN_LLM_MODEL ?? 'deepseek-chat').trim();

  ctx.provide(
    'planner',
    new LlmPlanner({
      engine,
      resolveKey: async () => {
        const key = (await secrets.get('llm_api_key')) ?? '';
        const source = key ? await secrets.source('llm_api_key') : 'none';
        return { key, source };
      },
      baseUrl,
      model,
      timeoutMs: 30_000,
      notify: (type, payload) => ctx.emit(type, payload),
    }),
  );

  const source = await secrets.source('llm_api_key');
  if (source === 'none') {
    ctx.log(
      '未配置 LLM Key（DPAPI 密钥仓库 / OPENCOXSWAIN_LLM_API_KEY / DEEPSEEK_API_KEY），使用静态拆分',
    );
  } else {
    ctx.log(`LLM Key 来源：${source}`);
  }
}
