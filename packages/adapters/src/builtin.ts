import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  newId,
  now,
  type AcceptanceResult,
  type CostLedger,
  type TaskContract,
  type WorkerResult,
} from '@opencoxswain/shared';
import type {
  HealthStatus,
  InputDelivery,
  InputReceipt,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  SessionOptions,
} from './adapter.js';
import { classifyAction } from './guard.js';
import {
  collectArtifacts,
  commitChanges,
  git,
  headOf,
  isWithin,
  judgeCriterion,
  matchesScope,
  runCommand,
  truncate,
} from './tooling.js';

/** 单次派发可用的模型凭据；由宿主插件在每次执行前解析，跟随设置页实时生效。 */
export interface BuiltinLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 仅用于决定是否关闭 DeepSeek 思考模式，缺省按地址推断。 */
  provider?: string;
}

export interface BuiltinOptions {
  /** 每次派发前解析凭据；返回 null 表示用户尚未配置 Key。 */
  resolve: () => Promise<BuiltinLlmConfig | null>;
  /** 单条验收命令超时。 */
  commandTimeoutMs?: number;
  /** 单轮对话最多调用模型的次数。 */
  maxSteps?: number;
  /** 单次模型请求超时。 */
  requestTimeoutMs?: number;
  env?: Record<string, string>;
}

interface ChatToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatResponse {
  message: ChatMessage;
  usage: ChatUsage;
}

interface DoneState {
  lastText: string;
  tokensIn: number;
  tokensOut: number;
  fatal: boolean;
}

class BuiltinSession implements RuntimeSession {
  readonly id = newId('ses');
  cancelled = false;
  paused = false;
  result: WorkerResult | null = null;
  baseHead: string | null = null;
  readonly inbox: InputDelivery[] = [];
  readonly abort = new AbortController();

  constructor(
    readonly taskId: string,
    readonly worktree: string,
    readonly options: SessionOptions,
  ) {}
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
]);

const MAX_READ_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 8_000;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return '请求超时';
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (causeText && !error.message.includes(causeText)) {
    return `${error.message}（${causeText}）`;
  }
  return error.message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeTools(readOnly: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取工作目录内的文本文件。返回文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作目录的文件路径' },
            start_line: { type: 'number', description: '可选，起始行号（1 基）' },
            end_line: { type: 'number', description: '可选，结束行号（含）' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出目录下的文件与子目录（自动跳过 .git、node_modules 等）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作目录的目录路径，默认 .' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: '在工作目录内按文件名或文件内容搜索文本，返回匹配的文件与行。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的文本（不区分大小写）' },
            path: { type: 'string', description: '可选，搜索起始目录，默认 .' },
            max_results: { type: 'number', description: '可选，最多返回条数，默认 50' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: '在工作目录内执行一条命令，返回退出码与输出。用于查看状态或运行测试。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令' },
          },
          required: ['command'],
        },
      },
    },
  ];

  if (!readOnly) {
    tools.push({
      type: 'function',
      function: {
        name: 'write_file',
        description: '把完整内容写入（覆盖）工作目录内的文件，父目录会自动创建。完成修改必须使用它。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作目录的文件路径' },
            content: { type: 'string', description: '文件的完整新内容' },
          },
          required: ['path', 'content'],
        },
      },
    });
  }

  return tools;
}

/**
 * 内置执行体：不依赖任何外部 CLI，直接用用户配置的 OpenAI 兼容模型
 * 驱动工具循环（读写文件、检索、跑命令），并在本地完成提交、验收与产物收集。
 */
export class BuiltinRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'builtin';
  readonly version = '1.0.0';
  readonly capabilities = { input: true, approvalGate: true, resume: false };
  readonly supportsApprovalGate = true;

  private readonly sessions = new Map<string, BuiltinSession>();
  private readonly resolveConfig: () => Promise<BuiltinLlmConfig | null>;
  private readonly commandTimeoutMs: number;
  private readonly maxSteps: number;
  private readonly requestTimeoutMs: number;
  private readonly env: Record<string, string>;

  constructor(options: BuiltinOptions) {
    this.resolveConfig = options.resolve;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxSteps = options.maxSteps ?? 40;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
    this.env = options.env ?? {};
  }

  async healthCheck(): Promise<HealthStatus> {
    let config: BuiltinLlmConfig | null = null;
    try {
      config = await this.resolveConfig();
    } catch (error) {
      return { ok: false, detail: `读取模型配置失败：${errorText(error)}` };
    }
    if (!config) {
      return { ok: false, detail: '未配置 LLM API Key，内置执行体无法运行' };
    }
    return { ok: true, detail: `builtin ready (${config.model} @ ${config.baseUrl})` };
  }

  async createSession(options: SessionOptions): Promise<RuntimeSession> {
    const info = await stat(options.worktree);
    if (!info.isDirectory()) {
      throw new Error(`worktree 不是目录：${options.worktree}`);
    }
    const session = new BuiltinSession(options.taskId, options.worktree, options);
    session.baseHead = await headOf(options.worktree);
    this.sessions.set(session.id, session);
    return session;
  }

  async cancel(session: RuntimeSession): Promise<void> {
    session.cancelled = true;
    const target = this.sessions.get(session.id);
    target?.abort.abort();
  }

  async sendInput(session: RuntimeSession, input: InputDelivery): Promise<InputReceipt> {
    const target = this.requireSession(session);
    target.inbox.push(input);
    return 'delivered';
  }

  async collect(session: RuntimeSession): Promise<WorkerResult> {
    const target = this.requireSession(session);
    if (!target.result) {
      throw new Error(`会话 ${session.id} 还没有结果`);
    }
    return target.result;
  }

  async dispose(session: RuntimeSession): Promise<void> {
    const target = this.sessions.get(session.id);
    target?.abort.abort();
    this.sessions.delete(session.id);
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.cancelled = true;
      session.abort.abort();
    }
    this.sessions.clear();
  }

  async *send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const artifactsDir = path.join(this.artifactsRoot(session), task.task_id);
    await mkdir(artifactsDir, { recursive: true });
    const logsRef = path.join(artifactsDir, 'builtin.jsonl');
    await writeFile(logsRef, '');

    const emit = async (event: RuntimeEvent): Promise<RuntimeEvent> => {
      await appendFile(logsRef, `${JSON.stringify(event)}\n`);
      return event;
    };

    yield await emit({ type: 'started', at: now() });

    let config: BuiltinLlmConfig | null = null;
    try {
      config = await this.resolveConfig();
    } catch (error) {
      yield await emit({
        type: 'error',
        at: now(),
        message: `读取模型配置失败：${errorText(error)}`,
        retryable: false,
      });
      return;
    }
    if (!config) {
      yield await emit({
        type: 'error',
        at: now(),
        message: '未配置 LLM API Key，无法执行任务。请在设置页填写密钥后重试。',
        retryable: false,
      });
      return;
    }
    if (target.cancelled) return;

    const startedAt = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(session, task) },
      { role: 'user', content: this.userPrompt(task) },
    ];
    const state: DoneState = { lastText: '', tokensIn: 0, tokensOut: 0, fatal: false };

    for await (const event of this.drive(session, task, config, messages, this.maxSteps, state)) {
      yield await emit(event);
    }
    if (state.fatal || target.cancelled) return;

    // 空转补救：需要 diff 但一个文件都没改时，明确要求模型继续动手，而不是直接失败。
    if (!session.options.role.readOnly && this.wantsChanges(task) && !(await this.hasChanges(session))) {
      messages.push({
        role: 'user',
        content:
          '你还没有修改任何文件，任务无法通过验收。请立刻用 write_file 把需要改动的文件完整写入，然后简短说明结果；不要只描述计划。',
      });
      for await (const event of this.drive(session, task, config, messages, 10, state)) {
        yield await emit(event);
      }
      if (state.fatal || target.cancelled) return;
    }

    if (!session.options.role.readOnly) {
      const committed = await commitChanges(session.worktree, `opencoxswain: ${task.title}`);
      if (committed) {
        yield await emit({ type: 'message', at: now(), text: '变更已提交到任务分支。' });
      }
    }

    const acceptance: AcceptanceResult[] = [];
    for (const [index, criterion] of task.acceptance_criteria.entries()) {
      if (target.cancelled) return;
      const result = await judgeCriterion(criterion, {
        worktree: session.worktree,
        baseHead: target.baseHead,
        roleName: session.options.role.name,
        writeScope: task.write_scope ?? [],
        env: { ...process.env, ...this.env, ...session.options.env },
        timeoutMs: this.commandTimeoutMs,
      });
      acceptance.push(result);
      yield await emit({
        type: 'progress',
        at: now(),
        percent: Math.round(((index + 1) / task.acceptance_criteria.length) * 70) + 20,
        note: `${criterion.id} ${result.status}`,
      });
    }

    const artifacts = await collectArtifacts({
      worktree: session.worktree,
      baseHead: target.baseHead,
      task,
      roleName: session.options.role.name,
      acceptance,
      artifactsDir,
    });
    for (const artifact of artifacts) {
      yield await emit({ type: 'artifact', at: now(), artifact });
    }

    const cost: CostLedger = {
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      usd: 0,
      minutes: round((Date.now() - startedAt) / 60_000, 2),
    };
    yield await emit({ type: 'cost', at: now(), cost });

    const passed = acceptance.filter((item) => item.status === 'passed').length;
    const failed = acceptance.filter((item) => item.status === 'failed').length;
    const unverified = acceptance.filter((item) => item.status === 'unverified').length;
    const result: WorkerResult = {
      summary: `${session.options.role.name} 通过内置执行体完成：${artifacts.length} 个产物，验收 ${passed} 通过 / ${failed} 失败 / ${unverified} 待确认。${state.lastText ? `\n\n${state.lastText}` : ''}`,
      artifacts,
      acceptance,
      cost,
      logsRef,
    };
    target.result = result;
    yield await emit({ type: 'progress', at: now(), percent: 100, note: '完成' });
    yield await emit({ type: 'finished', at: now(), result });
  }

  /** 模型 ↔ 工具循环：每轮最多一次模型响应，工具在本地受限执行。 */
  private async *drive(
    session: RuntimeSession,
    task: TaskContract,
    config: BuiltinLlmConfig,
    messages: ChatMessage[],
    maxSteps: number,
    state: DoneState,
  ): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const tools = describeTools(session.options.role.readOnly);

    for (let step = 0; step < maxSteps; step += 1) {
      if (target.cancelled) return;

      while (target.inbox.length > 0) {
        const input = target.inbox.shift()!;
        yield { type: 'input_received', at: now(), inputId: input.id };
        messages.push({
          role: 'user',
          content: `执行中的补充要求（${input.source}）：${input.text}`,
        });
        yield { type: 'message', at: now(), text: `已收到中途消息（${input.source}）：${input.text}` };
      }

      let response: ChatResponse;
      try {
        response = await this.chat(config, messages, tools, target);
      } catch (error) {
        const message = errorText(error);
        if (target.cancelled) return;
        yield {
          type: 'error',
          at: now(),
          message: `内置执行体调用模型失败：${message}`,
          retryable: !/HTTP 4\d\d/.test(message),
        };
        state.fatal = true;
        return;
      }

      const tokensIn = Number(response.usage.prompt_tokens) || 0;
      const tokensOut = Number(response.usage.completion_tokens) || 0;
      state.tokensIn += tokensIn;
      state.tokensOut += tokensOut;
      if (tokensIn > 0 || tokensOut > 0) {
        yield { type: 'cost', at: now(), cost: { tokensIn, tokensOut, usd: 0, minutes: 0 } };
      }

      const message = response.message;
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const text = typeof message.content === 'string' ? message.content : '';
      if (calls.length === 0) {
        if (text.trim() !== '') {
          state.lastText = text;
          yield { type: 'message', at: now(), text };
        }
        return;
      }

      messages.push({ role: 'assistant', content: text || null, tool_calls: calls });
      if (text.trim() !== '') {
        state.lastText = text;
        yield { type: 'message', at: now(), text };
      }

      for (const call of calls) {
        if (target.cancelled) return;
        const name = call.function?.name ?? 'unknown';
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function?.arguments ?? '{}') as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: '错误：工具参数不是合法 JSON，请重新调用。',
          });
          continue;
        }

        yield { type: 'tool_call', at: now(), tool: name, input: args };

        const category = classifyAction(name, args);
        if (category && session.options.gate) {
          const decision = await session.options.gate.request({ tool: name, input: args, category });
          if (decision === 'rejected') {
            yield {
              type: 'tool_result',
              at: now(),
              tool: name,
              output: { ok: false, rejected: true },
            };
            yield {
              type: 'error',
              at: now(),
              message: `危险动作被拒绝：${name}（${category}）`,
              retryable: false,
            };
            state.fatal = true;
            return;
          }
        }

        const result = await this.execTool(session, task, name, args);
        yield {
          type: 'tool_result',
          at: now(),
          tool: name,
          output: { ok: result.ok, detail: truncate(result.content, 500) },
        };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: truncate(result.content, MAX_OUTPUT_CHARS),
        });
      }
    }
  }

  private async execTool(
    session: RuntimeSession,
    task: TaskContract,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    try {
      switch (name) {
        case 'read_file':
          return await this.readTool(session, args);
        case 'list_dir':
          return await this.listTool(session, args);
        case 'search_files':
          return await this.searchTool(session, args);
        case 'write_file':
          return await this.writeTool(session, task, args);
        case 'run_command':
          return await this.commandTool(session, args);
        default:
          return { ok: false, content: `错误：未知工具 ${name}` };
      }
    } catch (error) {
      return { ok: false, content: `工具 ${name} 执行失败：${errorText(error)}` };
    }
  }

  private async readTool(
    session: RuntimeSession,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const abs = this.inside(session.worktree, String(args.path ?? ''));
    if (!abs) return { ok: false, content: '错误：路径越出工作目录，已拒绝' };
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return { ok: false, content: `错误：文件不存在：${String(args.path)}` };
    let text = await readFile(abs, 'utf8');
    const start = Number(args.start_line);
    const end = Number(args.end_line);
    if (Number.isInteger(start) && start > 0) {
      const lines = text.split(/\r?\n/);
      const from = start - 1;
      const to = Number.isInteger(end) && end >= start ? end : lines.length;
      text = lines.slice(from, to).join('\n');
    }
    if (text.length > MAX_READ_CHARS) {
      text = `${text.slice(0, MAX_READ_CHARS)}\n…（文件较长，已截断）`;
    }
    return { ok: true, content: text };
  }

  private async listTool(
    session: RuntimeSession,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const abs = this.inside(session.worktree, String(args.path ?? '.') || '.');
    if (!abs) return { ok: false, content: '错误：路径越出工作目录，已拒绝' };
    const info = await stat(abs).catch(() => null);
    if (!info?.isDirectory()) return { ok: false, content: `错误：目录不存在：${String(args.path ?? '.')}` };
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !SKIP_DIRS.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 200)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { ok: true, content: lines.length > 0 ? lines.join('\n') : '（空目录）' };
  }

  private async searchTool(
    session: RuntimeSession,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const query = String(args.query ?? '').trim();
    if (!query) return { ok: false, content: '错误：query 不能为空' };
    const abs = this.inside(session.worktree, String(args.path ?? '.') || '.');
    if (!abs) return { ok: false, content: '错误：路径越出工作目录，已拒绝' };
    const limit = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
    const needle = query.toLowerCase();
    const hits: string[] = [];
    let scanned = 0;

    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= limit || scanned >= 3000) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (hits.length >= limit || scanned >= 3000) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        scanned += 1;
        const relative = path.relative(session.worktree, full).replaceAll('\\', '/');
        if (relative.toLowerCase().includes(needle)) {
          hits.push(`${relative}（文件名匹配）`);
          continue;
        }
        const size = (await stat(full).catch(() => null))?.size ?? 0;
        if (size > 512 * 1024) continue;
        const content = await readFile(full, 'utf8').catch(() => '');
        if (!content.toLowerCase().includes(needle)) continue;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (line.toLowerCase().includes(needle)) {
            hits.push(`${relative}:${index + 1}: ${line.trim().slice(0, 200)}`);
            if (hits.length >= limit) return;
          }
        }
      }
    };

    await walk(abs);
    return {
      ok: true,
      content: hits.length > 0 ? hits.join('\n') : `没有找到匹配「${query}」的文件或内容`,
    };
  }

  private async writeTool(
    session: RuntimeSession,
    task: TaskContract,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    if (session.options.role.readOnly) {
      return { ok: false, content: '错误：当前角色只读，不允许写文件' };
    }
    const raw = String(args.path ?? '').trim();
    if (!raw) return { ok: false, content: '错误：path 不能为空' };
    const abs = this.inside(session.worktree, raw);
    if (!abs) return { ok: false, content: '错误：路径越出工作目录，已拒绝' };
    const relative = path.relative(session.worktree, abs).replaceAll('\\', '/');
    const scope = task.write_scope ?? [];
    if (scope.length > 0 && !scope.some((prefix) => matchesScope(relative, prefix))) {
      return {
        ok: false,
        content: `错误：${relative} 不在任务写域（${scope.join('、')}）内，已拒绝。请只修改写域内的文件。`,
      };
    }
    const content = typeof args.content === 'string' ? args.content : '';
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return { ok: true, content: `已写入 ${relative}（${Buffer.byteLength(content, 'utf8')} 字节）` };
  }

  private async commandTool(
    session: RuntimeSession,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const command = String(args.command ?? '').trim();
    if (!command) return { ok: false, content: '错误：command 不能为空' };
    const result = await runCommand(
      command,
      session.worktree,
      { ...process.env, ...this.env, ...session.options.env },
      this.commandTimeoutMs,
    );
    const output = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.code === 0,
      content: truncate(`exit ${result.code}\n${output}`, MAX_OUTPUT_CHARS),
    };
  }

  private async chat(
    config: BuiltinLlmConfig,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    session: BuiltinSession,
  ): Promise<ChatResponse> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const deepseek =
      config.provider === 'deepseek' || /deepseek\.com/i.test(config.baseUrl);
    const body = JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 8192,
      stream: false,
      ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
    });

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (session.cancelled) throw new Error('任务已取消');
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: AbortSignal.any([
            session.abort.signal,
            AbortSignal.timeout(this.requestTimeoutMs),
          ]),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).trim().slice(0, 400);
          const error = new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
          if (response.status >= 500 && attempt < 2) {
            lastError = error;
            await delay(1000 * (attempt + 1));
            continue;
          }
          throw error;
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: ChatMessage }>;
          usage?: ChatUsage;
        };
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('模型返回缺少 message');
        return { message, usage: data.usage ?? {} };
      } catch (error) {
        if (session.cancelled) throw new Error('任务已取消');
        lastError = error;
        const text = errorText(error);
        if (/HTTP 4\d\d/.test(text) || /任务已取消/.test(text)) throw error;
        if (attempt >= 2) throw error;
        await delay(1000 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('模型请求失败');
  }

  private inside(root: string, target: string): string | null {
    if (!target.trim()) return null;
    const abs = path.resolve(root, target);
    return isWithin(root, abs) ? abs : null;
  }

  private requireSession(session: RuntimeSession): BuiltinSession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`未知会话：${session.id}`);
    return target;
  }

  private artifactsRoot(session: RuntimeSession): string {
    return (
      session.options.env.OPENCOXSWAIN_ARTIFACTS_DIR ??
      path.join(os.tmpdir(), 'opencoxswain-artifacts')
    );
  }

  private wantsChanges(task: TaskContract): boolean {
    return (
      task.acceptance_criteria.some((criterion) => criterion.type === 'diff') ||
      (task.deliverables ?? []).some((item) => item.type === 'diff')
    );
  }

  private async hasChanges(session: RuntimeSession): Promise<boolean> {
    const status = await git(session.worktree, ['status', '--porcelain']);
    return status.code === 0 && status.stdout.trim() !== '';
  }

  private systemPrompt(session: RuntimeSession, task: TaskContract): string {
    const scope = session.options.role.readOnly ? [] : task.write_scope ?? [];
    return [
      '你是 OpenCoxswain 内置执行体，一名独立完成任务的 AI 员工。',
      '你直接在当前工作目录（git worktree）里动手，必须调用工具读取和修改真实文件，不要只给建议或计划。',
      session.options.role.readOnly
        ? '当前角色只读：不要修改、创建或删除任何文件，只做检查并汇报结论。'
        : `当前角色可写。只能修改这些路径：${scope.length === 0 ? '仓库根目录内' : scope.join('、')}。`,
      '写文件必须一次给出完整内容（write_file 会覆盖原文件）。修改前先 read_file 了解现状。',
      process.platform === 'win32'
        ? '运行环境是 Windows：命令请用 Windows 写法（如 type / dir / findstr），不要用 cat / ls / grep 等 Unix 命令；优先用 read_file / list_dir / search_files 查看内容。'
        : `运行环境是 ${process.platform}，命令请使用本机可用的 shell 写法。`,
      '不要创建新的 worktree，不要切换分支，不要执行 git push / git commit（系统会代为提交）。',
      '完成后用简短中文说明你改了什么、验证了什么、还有哪些风险。',
    ].join('\n');
  }

  private userPrompt(task: TaskContract): string {
    const lines = [`任务：${task.title}`, `目标：${task.goal}`];
    if (task.constraints && task.constraints.length > 0) {
      lines.push('', '约束：', ...task.constraints.map((item) => `- ${item}`));
    }
    if (task.acceptance_criteria.length > 0) {
      lines.push('', '验收项（系统会自动复核）：');
      for (const criterion of task.acceptance_criteria) {
        lines.push(
          `- ${criterion.id}（${criterion.type}）：${criterion.desc}${criterion.check ? `，命令：${criterion.check}` : ''}`,
        );
      }
    }
    if (task.write_scope && task.write_scope.length > 0) {
      lines.push('', `允许写入：${task.write_scope.join('、')}`);
    }
    lines.push('', '现在开始：先用 list_dir / read_file 了解代码，再用 write_file 完成修改。');
    return lines.join('\n');
  }
}
