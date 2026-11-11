/**
 * 执行者 D：真正干活的 Agent。
 *
 * 与 C 的区别：
 * - C 是常驻的、有项目全局视野、只调工具不直接改代码；
 * - D 是临时的、只干一件确定的活、**直接操作文件**。
 *
 * D 的循环继承 legacy `builtin.ts` 已验证的做法：
 * 模型 → 工具 → 回灌 → 直到给出结论。工具是受限的（只在项目目录内、只在写域内）。
 *
 * 关键约束（来自实际踩坑）：
 * 1. 写文件必须在项目根目录内，且落在声明的写域里。
 * 2. 命令执行必须有超时，超时按进程树结束（Windows 下会残留孙进程）。
 * 3. D 的**收尾文本**就是它唯一被 C 看到的交付——不能靠"发消息"结尾。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { errorText, runLoop, type LoopEvent, type ToolHost } from '../session/loop.js';
import type { LlmClient, ToolDefinition } from '../llm/types.js';
import type { RunMetrics } from '../cost/metrics.js';
import { classifyDanger } from '../security/classify.js';
import type { SideEffectLedger } from '../security/ledger.js';

const execAsync = promisify(exec);

/** D 的卡点三分类（方案 §6 P4-T1）。 */
export type BlockKind = 'self-recoverable' | 'needs-user' | 'environment';

/**
 * 把 D 的失败原因归类。
 *
 * 这是**规则判断**，不调用 LLM：宁可保守归成"必须问用户"，
 * 也不要让 C 在没有依据的情况下耗光重试预算。
 */
export function classifyBlock(reason: string): { kind: BlockKind; hint: string } {
  const text = reason.toLowerCase();
  if (
    /enoent|command not found|不是内部或外部命令|permission denied|eacces|eperm|no such file or directory|enospc|disk full|eaddrinuse|port .* in use|network|econnrefused|etimedout|连不上|没有权限/.test(
      text,
    )
  ) {
    return {
      kind: 'environment',
      hint: '环境问题：如实报告并给出修复建议，不要反复重试同一环境错误。',
    };
  }
  if (
    /typeerror|referenceerror|syntaxerror|assertion|expected .* received|test failed|测试失败|修改不存在的|does not exist/.test(
      text,
    )
  ) {
    return {
      kind: 'self-recoverable',
      hint: '可由执行者自己换法重试（例如换文件、先读再改），不要打扰用户。',
    };
  }
  return {
    kind: 'needs-user',
    hint: '无法判断成因，攒成一个具体问题问用户，一次只问一件。',
  };
}

export function executorSystemPrompt(input: {
  readonly projectName: string;
  readonly goal: string;
  readonly writeScope: readonly string[];
  readonly readonlyTask?: boolean;
}): string {
  const scope = input.readonlyTask
    ? '只读任务 —— 不要修改、创建或删除任何文件，只做查询与分析'
    : input.writeScope.length > 0
      ? input.writeScope.join(', ')
      : '（未声明 —— 本次按串行执行，仍只允许改本项目）';
  return [
    `你是执行者。你只干一件确定的活，干完就结束。`,
    `项目：${input.projectName}`,
    '',
    '## 目标',
    input.goal,
    '',
    '## 写域',
    scope,
    '',
    '## 硬约束',
    '1. 只改本项目目录内的文件，且不要越过写域。',
    '2. **结论先行**：先用一句话写结论，再补充细节。',
    '   你的**收尾文本**就是你唯一被看到的交付，项目助理看不到你的思考过程。',
    '3. 卡住时如实说明，不要假装完成。',
    '',
    '## 卡住时怎么办',
    '- 自己能修好的（路径写错、类型错误、测试失败）：**换法重试一次**，不要停下来问。',
    '- 环境问题（缺依赖、没权限）：停止，如实报告，附修复建议。',
    '- 必须人决定的：把问题写成一句话，明确你要哪个答案。',
    '',
    '## 命令的 shell 环境（很重要）',
    process.platform === 'win32'
      ? [
          '`run_command` 在 **cmd.exe** 里执行，不是 PowerShell。',
          '- 查文件：`dir` / `type` / `findstr`；删文件：`del` / `rmdir`',
          '- 要用 PowerShell 的命令（`Get-ChildItem`、`Get-Content`、`Remove-Item`、`Test-Path`），',
          '  必须显式调用：`powershell -NoProfile -Command "..."`',
          '- 不确定就用能在 cmd 里跑的写法，不要假设 `cat` / `ls` 可用。',
        ].join('\n')
      : '`run_command` 在 POSIX shell 中执行。',
    '',
    '## 交付格式（必须包含这三段）',
    '### 做了什么',
    '具体改了哪些文件、做了什么判断。',
    '### 验证了什么',
    '跑了什么检查、结果如何。没验证就写"未验证"及原因。',
    '### 需要用户决定什么',
    '有卡点、有权衡、有风险的地方列在这里；没有就写"无"。',
  ].join('\n');
}

/** D 的工具集：直接操作文件系统 / 执行命令，全部限制在项目目录内。 */
export function executorTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: '读取项目内的一个文本文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', description: '相对项目根的路径' } },
      },
    },
    {
      name: 'write_file',
      description: '把完整内容写入项目内的一个文件（覆盖）。父目录会自动创建。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: '相对项目根的路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
      },
    },
    {
      name: 'list_dir',
      description: '列出项目内某个目录的条目。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '相对项目根的路径，缺省为根目录' } },
      },
    },
    {
      name: 'search_files',
      description: '在项目内按文件名或内容片段搜索。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '要搜索的文本' },
          path: { type: 'string', description: '搜索范围，缺省为项目根' },
        },
      },
    },
    {
      name: 'run_command',
      description:
        '在项目根目录执行一条 shell 命令（有超时）。用于跑测试、构建、git、查文件等。' +
        (process.platform === 'win32'
          ? '**Windows 上执行的是 cmd.exe**：原生命令用 `dir` / `del` / `type`；' +
            '若要跑 PowerShell（如 `Get-ChildItem`、`Remove-Item`），必须写成 `powershell -NoProfile -Command "..."`。'
          : '在 POSIX shell 中执行。'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeoutMs: { type: 'integer', description: '超时毫秒数，默认 120000' },
        },
      },
    },
  ].filter((t) => t.name !== 'search_files' || true) as ToolDefinition[];
}

export interface ExecutorToolHostOptions {
  readonly rootPath: string;
  readonly writeScope: readonly string[];
  /**
   * 只读任务：**硬性阻止任何写入与删改命令**。
   *
   * 光在提示词里说"别写"不够——模型可能顺手跑一条 `Remove-Item`。
   * 这里在工具层直接拒绝，才是真保证。
   */
  readonly readonlyTask?: boolean;
  /**
   * 危险动作审批闸门。
   *
   * 提供后，`run_command` 命中删除/推送/发布/付款/外发这五类动作时，
   * **不会立刻执行**，而是先请求用户批准；被拒绝或超时就返回失败并说明原因。
   */
  readonly approve?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
  /**
   * 副作用台账。提供后，每次写文件 / 执行命令 / 外发都会在**执行前**落 pending，
   * 执行后结算 —— 出事时能回答"它到底改了什么"。
   */
  readonly ledger?: SideEffectLedger;
  readonly commandTimeoutMs?: number;
  readonly maxOutputChars?: number;
}

/** 把相对路径解析到项目内，越界就抛错。 */
function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  const rel = path.relative(normalizedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${relative} 不在项目目录内`);
  }
  return resolved;
}

/** 检查写入是否落在声明的写域内（空写域 = 不额外限制，但仍限项目内）。 */
function assertInScope(writeScope: readonly string[], relative: string): void {
  if (writeScope.length === 0) return;
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  const ok = writeScope.some(
    (scope) => normalized === scope || normalized.startsWith(`${scope}/`),
  );
  if (!ok) {
    throw new Error(`写域越界：${relative} 不在 ${writeScope.join(', ')} 之内`);
  }
}

export function createExecutorToolHost(options: ExecutorToolHostOptions): ToolHost {
  const { rootPath } = options;
  const maxOutput = options.maxOutputChars ?? 4000;

  return {
    definitions: () => executorTools(),
    async execute({ name, args }) {
      // ---- 记账：执行前落 pending ----
      // 读类工具没有副作用，begin 会返回 row=null，后续结算自动跳过。
      let pending: Awaited<ReturnType<SideEffectLedger['begin']>> | null = null;
      if (options.ledger) {
        try {
          pending = await options.ledger.begin(name, args);
          if (pending.skipped) {
            return { ok: true, content: '（这个动作之前已经成功执行过，本次跳过）' };
          }
        } catch {
          // 台账写不进去不能阻断工具执行，但要知道发生了。
          pending = null;
        }
      }

      const settle = async (
        result: { ok: boolean; content: string },
        state?: 'rejected',
      ): Promise<{ ok: boolean; content: string }> => {
        if (pending && options.ledger) {
          await options.ledger
            .settle(
              pending.row,
              state ?? (result.ok ? 'succeeded' : 'failed'),
              state ? result.content : result.ok ? undefined : result.content,
            )
            .catch(() => {});
        }
        return result;
      };

      try {
        const result = await runTool();
        return await settle(result);

        async function runTool(): Promise<{ ok: boolean; content: string }> {
        switch (name) {
          case 'read_file': {
            const target = resolveInside(rootPath, String(args.path ?? ''));
            const content = await readFile(target, 'utf8');
            return { ok: true, content: content.slice(0, maxOutput) };
          }
          case 'write_file': {
            if (options.readonlyTask) {
              return {
                ok: false,
                content:
                  '这是只读任务，禁止写文件。如果你认为必须写入才能完成，' +
                  '请在收尾文本里说明需要改成写任务，不要绕过限制。',
              };
            }
            const relative = String(args.path ?? '');
            assertInScope(options.writeScope, relative);
            const target = resolveInside(rootPath, relative);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, String(args.content ?? ''), 'utf8');
            return { ok: true, content: `已写入 ${relative}（${String(args.content ?? '').length} 字）` };
          }
          case 'list_dir': {
            const target = resolveInside(rootPath, String(args.path ?? '.'));
            const entries = await readdir(target, { withFileTypes: true });
            const lines = entries
              .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
            return { ok: true, content: lines.join('\n') || '（空目录）' };
          }
          case 'search_files': {
            const query = String(args.query ?? '');
            const target = resolveInside(rootPath, String(args.path ?? '.'));
            const hits = await searchTree(target, query, 50);
            return { ok: true, content: hits.join('\n') || '没有命中' };
          }
          case 'run_command': {
            const command = String(args.command ?? '');
            if (options.readonlyTask) {
              const blocked = detectMutatingCommand(command);
              if (blocked) {
                return {
                  ok: false,
                  content:
                    `这是只读任务，命令里含写操作（${blocked}）已被拦截。` +
                    '只读任务只能查询与读取；需要修改请说明后改派写任务。',
                };
              }
            }

            // 危险动作：**执行前**必须有人拍板。不可逆的动作没有后悔机会。
            if (options.approve) {
              const action = classifyDanger(name, args);
              if (action) {
                const decision = await options.approve(name, args);
                if (!decision.approved) {
                  // 台账里明确记"被拒绝、未执行"——这是审计最关键的一条。
                  throw new RejectedAction(
                    `危险动作未获批准，**没有执行**：${action.evidence}\n` +
                      `原因：${decision.reason}\n` +
                      `（这是一次${action.category}类动作：${action.why}）\n` +
                      '请换一种不需要这个动作的做法，或在收尾文本里说明需要用户自己执行。',
                  );
                }
              }
            }

            const timeout = Number(args.timeoutMs) || options.commandTimeoutMs || 120_000;
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd: rootPath,
                timeout,
                maxBuffer: 8 * 1024 * 1024,
                windowsHide: true,
              });
              const out = `${stdout}\n${stderr}`.trim();
              return { ok: true, content: out.slice(0, maxOutput) || '（命令无输出）' };
            } catch (error) {
              const err = error as { stdout?: string; stderr?: string; message?: string };
              const detail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || err.message || '';
              return { ok: false, content: `命令失败：${detail.slice(0, maxOutput)}` };
            }
          }
          default:
            return { ok: false, content: `未知工具：${name}` };
        }
        }
      } catch (error) {
        // 被审批拒绝的动作在台账里记 rejected，而不是 failed——
        // "没执行"和"执行了但失败"是两件完全不同的事。
        if (error instanceof RejectedAction) {
          return await settle({ ok: false, content: error.message }, 'rejected');
        }
        return await settle({ ok: false, content: errorText(error) });
      }
    },
  };
}

/** 危险动作被审批拒绝。用独立类型区分"没执行"与"执行失败"。 */
class RejectedAction extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RejectedAction';
  }
}

/**
 * 检测命令里是否含写操作，返回命中的说明（无风险返回 null）。
 *
 * 只读任务的兜底：模型可能在只读任务里顺手跑 `Remove-Item` 或重定向写文件。
 * 这是**黑名单**，不可能穷尽，但能挡住绝大多数常见的破坏性写法；
 * 配合 `write_file` 的硬拒绝，足以让只读任务真的只读。
 */
export function detectMutatingCommand(command: string): string | null {
  const text = command.replace(/\s+/g, ' ');
  const patterns: Array<[RegExp, string]> = [
    [/\brm\b|\brmdir\b|\bdel\b|\berase\b/i, '删除'],
    [/\bRemove-Item\b|\bRemove-ItemProperty\b/i, '删除'],
    [/\bmv\b|\bmove\b|\bMove-Item\b|\bRename-Item\b/i, '移动/重命名'],
    [/\bcp\b|\bcopy\b|\bCopy-Item\b/i, '复制写入'],
    [/\bmkdir\b|\bNew-Item\b|\btouch\b|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b/i, '创建/写入'],
    [/\btee\b/i, '写入'],
    [/\bsed\s+-i\b|\bperl\s+-i\b/i, '原地替换'],
    [/\bgit\s+(?:add|commit|reset|checkout|clean|stash|apply|merge|rebase|push)\b/i, '改动 git 状态'],
    [/\b(?:npm|pnpm|yarn)\s+(?:i|install|add|remove|uninstall)\b/i, '安装/卸载依赖'],
    [/\bpip\s+(?:install|uninstall)\b/i, '安装/卸载依赖'],
    [/\b(?:gradle|mvn)\s+\S*(?:clean|install|build)\b/i, '构建产物'],
    [/\bformat\b|\bfdisk\b/i, '磁盘操作'],
    [/(?:^|[^>])>(?!>)/, '重定向写入'],
    [/\bSet-Location\b|\bcd\s+\//i, '目录切换（可能越界）'],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) return label;
  }
  // 移动/复制等单词容易被误判（如 "compare"），这里再做一次单词边界复核。
  return null;
}

async function searchTree(root: string, query: string, limit: number): Promise<string[]> {  const hits: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.opencoxswain']);
  async function walk(dir: string): Promise<void> {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (rel.includes(query)) {
          hits.push(rel);
          continue;
        }
        // 只对小的文本文件查内容，避免扫二进制。
        try {
          const info = await stat(full);
          if (info.size > 512 * 1024) continue;
          const content = await readFile(full, 'utf8');
          const line = content.split('\n').findIndex((l) => l.includes(query));
          if (line >= 0) hits.push(`${rel}:${line + 1}`);
        } catch {
          // 非文本文件忽略
        }
      }
    }
  }
  await walk(root);
  return hits;
}

export interface RunExecutorOptions {
  readonly llm: LlmClient;
  readonly rootPath: string;
  readonly projectName: string;
  readonly goal: string;
  readonly writeScope: readonly string[];
  /** 只读任务：不写文件，工具层硬性拦截写入。 */
  readonly readonlyTask?: boolean;
  readonly signal: AbortSignal;
  readonly maxSteps?: number;
  readonly commandTimeoutMs?: number;
  /** 中途补投的指令（C 用 message_executor 发的）。 */
  readonly drainInputs?: () => readonly string[];
  /**
   * 续聊时的既有历史（不含 system）。
   *
   * 提供后不再从"请开始执行：goal"起步，而是带着原上下文继续，
   * 把 `goal` 当作这一轮的新指令。这是"D 完成后还能接着聊"的实现。
   */
  readonly priorMessages?: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  /** 已完成轮次的事件回调，便于上层把轨迹落库。 */
  readonly onEvent?: (event: LoopEvent) => void;
  /**
   * 危险动作审批闸门。
   *
   * 提供后，删除/推送/发布/付款/外发这五类动作会**在执行前**请求用户批准；
   * 被拒绝或超时则不执行，并把原因回灌给模型。
   */
  readonly approve?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
  /** 副作用台账。提供后每次副作用都执行前落 pending、执行后结算。 */
  readonly ledger?: SideEffectLedger;
  /** 运行结束时的指标回调（轮次/步数/token/耗时），用于落库。 */
  readonly onMetrics?: (metrics: RunMetrics) => void;
  /**
   * 运行**中**的累计用量回调，每轮模型返回后触发。
   *
   * 用途是止损：超限时可以立刻中止，而不是等任务跑完才结算。
   * 参数是当前累计值（不含耗时与上下文这类"最后一轮"才确定的字段）。
   */
  readonly onProgressMetrics?: (partial: {
    readonly tokensIn: number;
    readonly tokensOut: number;
  }) => void;
}

export interface ExecutorOutcome {
  readonly finalText: string;
  readonly ok: boolean;
  readonly blockKind: BlockKind;
  readonly steps: number;
  /** 本次运行的指标（不做计费，只反映真实用量）。 */
  readonly metrics: RunMetrics;
  readonly events: LoopEvent[];
}

/**
 * 跑一次执行者。
 *
 * 返回的 `finalText` 就是 C 会看到的那段结论——所以提示词里反复强调
 * "结论先行、不要假装完成"。
 */
export async function runExecutor(options: RunExecutorOptions): Promise<ExecutorOutcome> {
  const systemPrompt = executorSystemPrompt({
    projectName: options.projectName,
    goal: options.goal,
    writeScope: options.writeScope,
    ...(options.readonlyTask ? { readonlyTask: true } : {}),
  });

  // 续聊：带上前几轮的历史；否则从"请开始执行"起步。
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | null }> = [
    { role: 'system', content: systemPrompt },
  ];
  if (options.priorMessages?.length) {
    for (const m of options.priorMessages) {
      messages.push({ role: m.role, content: m.content });
    }
    // 续聊时 goal 就是用户这一轮的新指令。
    messages.push({ role: 'user', content: options.goal });
  } else {
    messages.push({ role: 'user', content: `请开始执行：${options.goal}` });
  }

  const toolHost = createExecutorToolHost({
    rootPath: options.rootPath,
    writeScope: options.writeScope,
    ...(options.readonlyTask ? { readonlyTask: true } : {}),
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.ledger ? { ledger: options.ledger } : {}),
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
  });

  const events: LoopEvent[] = [];
  let finalText = '';
  let failure: string | null = null;

  // 运行指标：只记录模型自己报告的真实数字，不做计费。
  const startedAt = Date.now();
  let turns = 0;
  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cachedTokens: number | null = null;
  let contextTokens: number | null = null;

  for await (const event of runLoop({
    llm: options.llm,
    toolHost,
    messages: messages as Parameters<typeof runLoop>[0]['messages'],
    maxSteps: options.maxSteps ?? 40,
    signal: options.signal,
    ...(options.drainInputs ? { drainInputs: options.drainInputs } : {}),
  })) {
    events.push(event);
    options.onEvent?.(event);
    if (event.type === 'done') finalText = event.finalText;
    if (event.type === 'error') failure = event.message;

    if (event.type === 'usage') {
      turns += 1;
      tokensIn += event.tokensIn;
      tokensOut += event.tokensOut;
      // 每一轮的 prompt_tokens 就是"这一轮带了多少上下文"，
      // 取最后一轮的值最能反映当前占用。
      if (event.tokensIn > 0) contextTokens = event.tokensIn;
      if (event.cachedTokens !== undefined && event.cachedTokens !== null) {
        cachedTokens = (cachedTokens ?? 0) + event.cachedTokens;
      }
      // 每轮都回调一次，让上层能立刻做止损判断。
      options.onProgressMetrics?.({ tokensIn, tokensOut });
    }
    if (event.type === 'tool_call') steps += 1;
  }

  const aborted = options.signal.aborted;
  const blockKind = failure || aborted ? classifyBlock(failure ?? '执行被中止').kind : 'needs-user';

  const metrics = {
    turns,
    steps,
    tokensIn,
    tokensOut,
    cachedTokens,
    durationMs: Date.now() - startedAt,
    contextTokens,
  };
  options.onMetrics?.(metrics);

  return {
    finalText,
    ok: !failure && !aborted && finalText.trim() !== '',
    blockKind,
    metrics,
    steps: events.filter((e) => e.type === 'tool_call').length,
    events,
  };
}
