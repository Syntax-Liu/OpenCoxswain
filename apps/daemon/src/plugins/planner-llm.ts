import type {
  LlmConfig,
  LlmConfigStatus,
  LlmProvider,
  LlmTestResult,
  OpenCoxswainConfig,
  PlanResult,
  PlannerService,
  PluginContext,
  RuntimeRegistry,
  SecretSource,
  StorageService,
} from '@opencoxswain/plugin-api';
import type {
  AcceptanceCriterion,
  CreatePlanRequest,
  Deliverable,
  MemoryMatch,
  PlannerStatus,
  Project,
  RoleName,
  SubtaskDraft,
} from '@opencoxswain/shared';
import { PLAN_NOT_DECOMPOSED } from '@opencoxswain/core';
import { Planner } from '../planner.js';
import {
  currentBaseUrl,
  currentModel,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OPENCODE_FREE_MODEL,
  OPENCODE_PROVIDER_ID,
  SETTING_BASE_URL,
  SETTING_MODEL,
  SETTING_PROVIDER,
} from './llm-target.js';

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

const MEMORY_LABELS: Record<MemoryMatch['entry']['kind'], string> = {
  profile: '偏好',
  project: '项目',
  decision: '决策',
  lesson: '教训',
};

const SYSTEM_PROMPT = [
  '你是 OpenCoxswain 的总管 Planner。你只输出 JSON，不输出任何解释。',
  '把用户目标拆成 2-5 个可独立执行、带依赖关系的子任务。每个子任务由一名 AI 员工在独立 git worktree 中执行。',
  '角色只能是：implementer（实施，可写文件）、verifier（校验，只读）、researcher（调研，只读）、writer（写作，可写文件）。',
  '校验类子任务必须通过 dependsOn 指向实施任务（0 基索引）。',
  '每个子任务的 acceptance 至少包含一个可自动验证的标准：command（带 check）、diff（依赖 writeScope），或 rubric + evidence_required（如 anchor/assertion）；human 只用于确实需要主观判断的项。',
  'writeScope 使用仓库相对路径或目录前缀；verifier / researcher 留空数组。',
].join('\n');

const PROVIDERS: ReadonlySet<string> = new Set<LlmProvider>(['deepseek', 'openai', 'custom']);

interface LlmPlannerOptions {
  engine: Planner;
  resolveKey: () => Promise<{ key: string; source: SecretSource; backend: string }>;
  recall: (query: string, projectId: string) => MemoryMatch[];
  settings: Pick<StorageService, 'getSetting' | 'setSetting'>;
  executor: () => { runtime: string; model: string };
  envBaseUrl?: string;
  envModel?: string;
  timeoutMs: number;
  notify: (type: string, payload: unknown) => void;
}

export class LlmPlanner implements PlannerService {
  private lastError: { message: string; at: number } | null = null;

  constructor(private readonly options: LlmPlannerOptions) {}

  async status(): Promise<PlannerStatus> {
    const { key } = await this.options.resolveKey();
    return key
      ? { mode: 'llm', reason: null }
      : { mode: 'static', reason: '未配置 LLM Key，使用静态拆分' };
  }

  /** 读取当前生效的模型配置：已保存设置 → 环境变量 → 内置默认值。 */
  config(): LlmConfig {
    const stored = this.options.settings.getSetting(SETTING_PROVIDER) ?? '';
    const provider = (PROVIDERS.has(stored) ? stored : 'deepseek') as LlmProvider;
    const baseUrl = currentBaseUrl(this.options.settings, this.options.envBaseUrl);
    // deepseek-chat / deepseek-reasoner 已于 2026-07-24 弃用，旧配置按官方映射换到 V4 名称。
    const model = currentModel(this.options.settings, this.options.envModel);
    return { provider, baseUrl: baseUrl || DEFAULT_BASE_URL, model: model || DEFAULT_MODEL };
  }

  async llmStatus(): Promise<LlmConfigStatus> {
    const { key, source, backend } = await this.options.resolveKey();
    return {
      config: this.config(),
      backend,
      key: { configured: key !== '', source },
      planner: await this.status(),
      executor: this.options.executor(),
      lastError: this.lastError,
    };
  }

  async configureLlm(patch: Partial<LlmConfig>): Promise<LlmConfigStatus> {
    const current = this.config();
    const provider = patch.provider ?? current.provider;
    if (!PROVIDERS.has(provider)) {
      throw new Error(`未知的模型提供商：${String(provider)}`);
    }
    const baseUrl = (patch.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      throw new Error('API 地址必须是 http(s) 开头的完整 URL');
    }
    const model = (patch.model ?? current.model).trim();
    if (!model || model.length > 100) {
      throw new Error('模型名不能为空，且不超过 100 个字符');
    }

    this.options.settings.setSetting(SETTING_PROVIDER, provider);
    this.options.settings.setSetting(SETTING_BASE_URL, baseUrl);
    this.options.settings.setSetting(SETTING_MODEL, model);
    this.lastError = null;
    return this.llmStatus();
  }

  async testLlm(): Promise<LlmTestResult> {
    const config = this.config();
    const { key } = await this.options.resolveKey();
    const started = Date.now();
    if (!key) {
      return { ok: false, ...config, latencyMs: 0, error: '未配置 API Key' };
    }
    try {
      await this.chat(key, config, [{ role: 'user', content: '只回复 ok' }], { maxTokens: 16 });
      this.lastError = null;
      return { ok: true, ...config, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      const message = errorText(error);
      this.lastError = { message, at: Date.now() };
      return { ok: false, ...config, latencyMs: Date.now() - started, error: message };
    }
  }

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

    const config = this.config();
    try {
      const references = this.options.recall(request.goal, project.id);
      const subtasks = await this.draft(request, key, references, config);
      this.lastError = null;
      this.options.notify('planner.llm.used', {
        model: config.model,
        baseUrl: config.baseUrl,
        subtasks: subtasks.length,
        keySource: source,
        memories: references.map((match) => match.entry.id),
      });
      return this.options.engine.plan(project, { ...request, subtasks });
    } catch (error) {
      const reason = errorText(error);
      this.lastError = { message: reason, at: Date.now() };
      this.options.notify('planner.fallback', { reason, model: config.model, baseUrl: config.baseUrl });
      return this.options.engine.plan(project, request);
    }
  }

  private async draft(
    request: CreatePlanRequest,
    apiKey: string,
    references: MemoryMatch[],
    config: LlmConfig,
  ): Promise<SubtaskDraft[]> {
    const content = await this.chat(
      apiKey,
      config,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: this.userPrompt(request, references) },
      ],
      { json: true, temperature: 0.2, maxTokens: 2048 },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      throw new Error('LLM 返回不是合法 JSON');
    }

    const raw = (parsed as { subtasks?: unknown }).subtasks;
    if (!Array.isArray(raw)) throw new Error('LLM 返回缺少 subtasks 数组');
    if (raw.length === 0) throw new Error(`${PLAN_NOT_DECOMPOSED}：LLM 未返回任何子任务`);
    const drafts = normalizeSubtasks(raw);
    assertDecomposed(drafts);
    return drafts;
  }

  /** 一次真实的 OpenAI 兼容调用；失败时把服务端原因带回给调用方。 */
  private async chat(
    apiKey: string,
    config: LlmConfig,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options: { json?: boolean; temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        // DeepSeek 默认开启思考模式，会忽略 temperature 并拖长响应；规划这类结构化输出关掉更稳。
        ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 400);
      throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('LLM 返回为空');
    }
    return content;
  }

  private userPrompt(request: CreatePlanRequest, references: MemoryMatch[] = []): string {
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
      references.length > 0
        ? [
            '',
            '已知记忆（可能相关；不适用的请忽略，不要虚构）：',
            ...references.map(
              (match) => `- [${MEMORY_LABELS[match.entry.kind]}] ${match.entry.text}`,
            ),
          ].join('\n')
        : null,
      '',
      '输出 JSON，结构如下：',
      '{"subtasks":[{"title":"实施：…","goal":"…","role":"implementer","dependsOn":[],"writeScope":["src/"],"acceptance":[{"id":"ac1","type":"command","desc":"测试通过","check":"npm test"}],"deliverables":[{"type":"diff","scope":"src/"}]}]}',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }
}

/** 把网络异常、超时与 HTTP 错误整理成一句可直接展示的原因。 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return '请求超时（30 秒）';
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (causeText && !error.message.includes(causeText)) {
    return `${error.message}（${causeText}）`;
  }
  return error.message;
}

function stripFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1]! : trimmed;
}

function assertDecomposed(drafts: SubtaskDraft[]): void {
  if (drafts.length === 0) {
    throw new Error(`${PLAN_NOT_DECOMPOSED}：LLM 未返回任何子任务`);
  }
  if (!drafts.some((draft) => draft.role === 'implementer' || draft.role === 'writer')) {
    throw new Error('计划结构非法：缺少实施/撰写角色');
  }
  if (!drafts.some((draft) => draft.role === 'verifier')) {
    throw new Error('计划结构非法：缺少校验角色');
  }
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

/**
 * 决定由谁真正执行子任务：显式配置优先；auto 时探测 OpenCode，可用就用真实执行体，
 * 否则退回 mock（mock 不改代码，任务会被判为空转失败）。
 */
async function resolveExecutor(
  config: OpenCoxswainConfig,
  storage: Pick<StorageService, 'getSetting'>,
  runtimes: RuntimeRegistry,
  apiKey: string,
): Promise<{ runtime: string; model: string }> {
  const name = config.defaultRuntime.trim();
  if (name && name !== 'auto') return { runtime: name, model: config.defaultModel };

  const opencode = runtimes.list().find((adapter) => adapter.name === 'opencode');
  if (!opencode) return { runtime: 'mock', model: config.defaultModel };
  let ok = false;
  try {
    ok = (await opencode.healthCheck()).ok;
  } catch {
    ok = false;
  }
  if (!ok) return { runtime: 'mock', model: config.defaultModel };
  return {
    runtime: 'opencode',
    // 有 Key 用用户自己的模型；没有 Key 退回 OpenCode 免费模型，任务照样真实执行。
    model: apiKey
      ? `${OPENCODE_PROVIDER_ID}/${currentModel(storage, config.defaultModel)}`
      : OPENCODE_FREE_MODEL,
  };
}

export async function apply(ctx: PluginContext): Promise<void> {
  const config = ctx.config;
  const employees = ctx.service('employees');
  const secrets = ctx.service('secrets');
  const memory = ctx.service('memory');
  const storage = ctx.service('storage');
  const runtimes = ctx.service('runtimes');

  const apiKey = (await secrets.get('llm_api_key')) ?? '';
  const executor = await resolveExecutor(config, storage, runtimes, apiKey);

  const engine = new Planner({
    runtime: executor.runtime,
    model: executor.model,
    employees,
  });

  ctx.provide(
    'planner',
    new LlmPlanner({
      engine,
      resolveKey: async () => {
        const key = (await secrets.get('llm_api_key')) ?? '';
        const source = key ? await secrets.source('llm_api_key') : 'none';
        return { key, source, backend: secrets.backend };
      },
      recall: (query, projectId) => memory.recall(query, { projectId, limit: 5 }),
      settings: storage,
      executor: () => ({ runtime: executor.runtime, model: executor.model }),
      envBaseUrl: process.env.OPENCOXSWAIN_LLM_BASE_URL,
      envModel: process.env.OPENCOXSWAIN_LLM_MODEL,
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
