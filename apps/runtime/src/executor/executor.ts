/**
 * Agent：真正干活的 Agent。
 *
 * 与 Assistant 的区别：
 * - C 是常驻的、有项目全局视野、只调工具不直接改代码；
 * - D 是临时的、只干一件确定的活、**直接操作文件**。
 *
 * Agent 的循环继承 legacy `builtin.ts` 已验证的做法：
 * 模型 → 工具 → 回灌 → 直到给出结论。工具是受限的（只在项目目录内、只在写域内）。
 *
 * 关键约束（来自实际踩坑）：
 * 1. 写文件必须在项目根目录内，且落在声明的写域里。
 * 2. 命令执行必须有超时，超时按进程树结束（Windows 下会残留孙进程）。
 * 3. Agent 的**收尾文本**就是它唯一被 Assistant 看到的交付——不能靠"发消息"结尾。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { errorText, runLoop, type LoopEvent, type ToolHost } from '../session/loop.js';
import { applyEdit } from './edit.js';
import { diffStat, unifiedDiff } from './diff.js';
import { matchGlob } from './glob.js';
import { readUrl, webSearch, type SearchConfig } from './web.js';
import { runSubagent } from './subagent.js';
import { judgeFailure, parseFailures, renderFailureReport } from './testJudge.js';
import { loadSkill, renderCatalog, type SkillSummary } from '../skills/index.js';
import type { McpTool } from '../mcp/client.js';
import { findSymbol, listSymbols, renderSymbolResult } from '../codeintel/symbols.js';
import { checkCommand } from './sandbox.js';
import type { SnapshotStore } from '../security/snapshot.js';
import type { LlmClient, ToolDefinition } from '../llm/types.js';
import type { RunMetrics } from '../cost/metrics.js';
import { classifyDanger } from '../security/classify.js';
import type { SideEffectLedger } from '../security/ledger.js';

const execAsync = promisify(exec);

/** Agent 的卡点三分类（方案 §6 P4-T1）。 */
export type BlockKind = 'self-recoverable' | 'needs-user' | 'environment';

/**
 * 把 Agent 的失败原因归类。
 *
 * 这是**规则判断**，不调用 LLM：宁可保守归成"必须问用户"，
 * 也不要让 Assistant 在没有依据的情况下耗光重试预算。
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
      hint: '可由Agent自己换法重试（例如换文件、先读再改），不要打扰用户。',
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
  /** 可用技能。只渲染名称和描述——正文要模型调 use_skill 才加载。 */
  readonly skills?: readonly SkillSummary[];
}): string {
  const scope = input.readonlyTask
    ? '只读任务 —— 不要修改、创建或删除任何文件，只做查询与分析'
    : input.writeScope.length > 0
      ? input.writeScope.join(', ')
      : '（未声明 —— 本次按串行执行，仍只允许改本项目）';
  // 技能目录：只占约 20 token/个。正文按需加载，这是省上下文的关键。
  const catalog = renderCatalog(input.skills ?? []);
  return [
    `你是Agent。你只干一件确定的活，干完就结束。`,
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
    '   你的**收尾文本**就是你唯一被看到的交付，Assistant看不到你的思考过程。',
    '3. 卡住时如实说明，不要假装完成。',
    '',
    '## 找代码时先想清楚用哪个工具',
    '- 「这个函数在哪定义、谁在调用」→ `find_symbol`（按标识符边界，不会把 foobar 当成 foo）',
    '- 「这个文件里有什么」→ `list_symbols`',
    '- 找某段文字 / 配置 / 注释 → `search_files`',
    '- 改一处代码 → `edit_file`（不要用 write_file 重写整个文件）',
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
    ...(catalog ? [catalog, ''] : []),
    '## 交付格式（必须包含这三段）',
    '### 做了什么',
    '具体改了哪些文件、做了什么判断。',
    '### 验证了什么',
    '跑了什么检查、结果如何。没验证就写"未验证"及原因。',
    '### 需要用户决定什么',
    '有卡点、有权衡、有风险的地方列在这里；没有就写"无"。',
  ].join('\n');
}

/** Agent 的工具集：直接操作文件系统 / 执行命令，全部限制在项目目录内。 */
export function executorTools(input: { readonly mcpTools?: readonly McpTool[] } = {}): ToolDefinition[] {
  const baseTools: ToolDefinition[] = [
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
      name: 'edit_file',
      description:
        '把文件里的一段文本替换成另一段（精确编辑，**优先用它而不是 write_file**）。\n' +
        'old_text 必须与文件内容逐字一致（含缩进）；new_text 是替换后的内容。\n' +
        '若 old_text 出现多次会报错——多带几行上下文定位，或用 replace_all 全部替换。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'old_text', 'new_text'],
        properties: {
          path: { type: 'string', description: '相对项目根的路径' },
          old_text: {
            type: 'string',
            description: '要被替换的原文（逐字复制，带足够上下文确保唯一）',
          },
          new_text: { type: 'string', description: '替换后的内容；删掉这段就传空字符串' },
          replace_all: {
            type: 'boolean',
            description: 'old_text 出现多次时是否全部替换（默认 false）',
          },
        },
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
      description:
        '在项目内搜文件或文件内容，**返回每一处匹配的行号和内容**。' +
        '\n- 只给 query：按文件名片段或内容片段搜' +
        '\n- regex: true：把 query 当正则' +
        '\n- glob：只搜路径匹配的文件，如 src/**/*.ts' +
        '\n- context：每个匹配行前后带几行（默认 0）',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '要搜索的文本或正则' },
          path: { type: 'string', description: '搜索范围，缺省为项目根' },
          regex: { type: 'boolean', description: '把 query 当正则（默认 false）' },
          glob: {
            type: 'string',
            description: '只搜路径匹配这个 glob 的文件，如 src/**/*.ts',
          },
          context: {
            type: 'integer',
            description: '每个匹配行前后带几行上下文（默认 0，最多 5）',
          },
        },
      },
    },
    {
      name: 'read_url',
      description:
        '抓取一个网页并返回**纯文本内容**（已去掉 HTML 标签）。' +
        '\n用于读文档、看 API 说明、查在线资料。' +
        '\n只支持 http/https；内容过长会截断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: '要抓取的网址（http 或 https）' },
        },
      },
    },
    {
      name: 'web_search',
      description:
        '联网搜索，返回若干条结果（标题 + 链接 + 摘要）。' +
        '\n**需要用户在设置里配置搜索服务**；没配时会明确告诉你不可用。' +
        '\n搜到链接后，用 read_url 读具体内容。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'integer', description: '返回几条（默认 5，最多 10）' },
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
    {
      name: 'find_symbol',
      description:
        '查找一个函数 / 类 / 变量的**定义位置和所有引用**。' +
        '做重构、改名、理解调用链时先用它，比文本搜索准（不会把 foobar 当成 foo）。\n' +
        '注意：这是词法层面的查找，同名不同作用域的符号会被混在一起。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: '符号名（函数名、类名、变量名）' },
          scope: { type: 'string', description: '限定搜索目录（相对项目根），缺省为全项目' },
        },
      },
    },
    {
      name: 'list_symbols',
      description: '列出一个文件里定义的所有函数 / 类 / 变量。了解文件结构时用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: '相对项目根的路径' },
        },
      },
    },
    {
      name: 'spawn_subagent',
      description:
        '派一个**子 Agent**去做一件可以独立完成的小事，**等它返回结果**。' +
        '\n\n和派 Agent 不同：子 Agent 是**为了当前这个任务**临时拆出来的分头活，' +
        '不建会话、不进侧栏、你看不到它的中间过程——只拿回它的结论。' +
        '\n\n什么时候用：需要同时查几处、或某个子问题很啰嗦但结论很短。' +
        '\n什么时候别用：子任务和你自己的任务强耦合，派出去反而要多解释一遍。' +
        '\n\n注意：子 Agent 默认**只读**，不能改文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: {
          task: { type: 'string', description: '子任务是什么，说清楚要什么结论' },
          context: {
            type: 'string',
            description: '它需要知道的背景（它看不到你和用户的对话）',
          },
        },
      },
    },
    {
      name: 'use_skill',
      description:
        '加载一个技能的完整说明。技能是"这个项目怎么做某类事"的知识' +
        '（比如测试怎么写、发布流程）。系统提示里只列出了技能名称和描述，' +
        '**需要时再调用这个工具拿正文**。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: '技能名（见系统提示里的「可用技能」）' },
        },
      },
    },
    {
      name: 'hand_back',
      description:
        '把这个任务**交回**给 Assistant，说明它不该由你继续做。' +
        '\n\n## 什么时候用\n' +
        '你查清之后发现：任务的前提不成立（要修的东西根本没问题）、\n' +
        '根因在别处（你被派来修登录，实际是数据库连接池配错）、\n' +
        '或者需要的权限/环境你没有。\n' +
        '\n## 什么时候别用\n' +
        '只是觉得难、想放弃 —— 那要继续做或者报失败，不要交回。\n' +
        '\n## 交回不是失败\n' +
        '你发现的东西会原样带给 Assistant，作为下一步的依据。\n' +
        '**一定要写清你查到了什么**，否则交回等于白干。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['reason', 'findings'],
        properties: {
          reason: {
            type: 'string',
            description: '为什么这件事不该由你做（一句话说清）',
          },
          findings: {
            type: 'string',
            description:
              '你查到的全部事实：证据、文件路径、行号、实际数值。' +
              '**这一段会原样转给 Assistant**，越具体越好。',
          },
          suggest: {
            type: 'string',
            description: '建议下一步该查/该做什么（可选，但很有用）',
          },
        },
      },
    },
  ];

  // MCP 工具：schema 直接复用，不做转换——避免我们的理解偏差导致参数校验不一致。
  const mcpTools: ToolDefinition[] = (input.mcpTools ?? []).map((tool) => ({
    name: tool.name,
    description: `${tool.description || '（无描述）'}（来自 MCP 服务器 ${tool.server}）`,
    parameters: tool.inputSchema,
  }));

  return [...baseTools, ...mcpTools];
}

/**
 * 命令输出截断：**保留开头和结尾，优先保留失败信息**。
 *
 * ## 为什么不能简单 slice
 *
 * 全量测试输出实测 34685 字符，而工具输出上限是 4000。
 * `slice(0, 4000)` 只保留前 11%——而**测试失败的摘要通常在末尾**。
 *
 * 结果是 Agent 看到一堆通过的测试，失败的那条被截掉了。
 * 它不是"判断能力弱"，是根本没看到该判断的东西。
 *
 * ## 策略
 *
 * 1. 输出本来就够短 → 原样返回
 * 2. 太长 → 头 30% + 尾 70%（尾部信息密度更高：错误、失败摘要、退出码）
 * 3. 中间被省掉的部分明确标注，并告诉 Agent 怎么拿到完整输出
 */
export function trimCommandOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // 尾部给更多空间：错误和失败摘要都在后面
  const headLen = Math.floor(limit * 0.3);
  const tailLen = limit - headLen;
  const omitted = text.length - limit;

  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);

  return (
    `${head}\n\n` +
    `……（中间省略 ${omitted} 字符）……\n\n` +
    `${tail}\n\n` +
    '（输出太长已截断。要看完整输出：把命令的输出重定向到文件，再用 read_file 读它。）'
  );
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
   * 沙箱放行的项目外目录。默认一条都没有——写操作只能落在项目内。
   */
  readonly allowOutside?: readonly string[];
  /**
   * 联网搜索的配置。
   *
   * 没配时 `web_search` 会明确返回"不可用"——
   * 不能让模型以为搜过了。
   */
  readonly search?: SearchConfig | null;

  /**
   * 当前嵌套深度。父 Agent 不传（视为 0），子 Agent 传 1、2……
   * 超过上限时 `spawn_subagent` 会拒绝。
   */
  readonly subagentDepth?: number;

  /**
   * 模型客户端。**只有要支持子 Agent 时才传**——
   * 不传的话 `spawn_subagent` 明确拒绝，而不是假装派出去了。
   */
  readonly llm?: LlmClient;

  /** 中止信号：子 Agent 跟着父 Agent 一起停。 */
  readonly signal?: AbortSignal;

  /** MCP 工具（名字已带服务器前缀）。调用时转发给对应服务器。 */
  readonly mcpTools?: readonly McpTool[];
  /** MCP 调用入口；提供后 mcpTools 里的工具才能真正执行。 */
  readonly mcp?: {
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
  };
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
  /**
   * 文件快照。提供后，写文件前会留一份原内容，用于事后撤销。
   *
   * 不提供就不备份——撤销功能整体不可用，但其它功能正常。
   */
  readonly snapshots?: SnapshotStore;
  /**
   * 用户扩展（geek 自定义口）。见 `extensions/index.ts`。
   *
   * 只提供"否决"与"观察"，不提供改参数、跳过审批、绕过验收——
   * 那些会破坏产品的信任基础。
   */
  readonly extensions?: {
    readonly beforeTool: ReadonlyArray<
      (input: {
        tool: string;
        args: Record<string, unknown>;
      }) => { veto: true; reason: string } | void
    >;
    readonly afterTool: ReadonlyArray<
      (input: { tool: string; args: Record<string, unknown>; ok: boolean }) => void
    >;
  };
  readonly commandTimeoutMs?: number;
  readonly maxOutputChars?: number;
  /** 可用技能列表（只含名称与描述）。模型调用 use_skill 时才读正文。 */
  readonly skills?: readonly SkillSummary[];
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
  /**
   * 本次派活里被写过的文件。
   *
   * 用途：判断测试失败时区分"测试文件被改过"还是"没改过"。
   * 改过的测试失败 → 可能是测试自己写错了；
   * 没改过的测试失败 → 更可能是实现有问题。
   */
  const changedFiles: string[] = [];

  /** 把失败列表渲染成带判断结论的文本；没有失败时返回空串。 */
  const categorize = (failures: ReturnType<typeof parseFailures>): string => {
    if (failures.length === 0) return '';
    return (
      '\n\n---\n' +
      renderFailureReport(
        failures,
        failures.map((f) => judgeFailure(f, { changedFiles })),
      ).slice(0, 3000)
    );
  };

  return {
    definitions: () => executorTools({ mcpTools: options.mcpTools ?? [] }),
    async execute({ name, args }) {
      // 记下写过的文件（工具失败时也记——它可能已经部分写入）
      if (name === 'write_file' || name === 'edit_file') {
        const p = String(args.path ?? '');
        if (p && !changedFiles.includes(p)) changedFiles.push(p);
      }
      // ---- 记账：执行前落 pending ----
      // 读类工具没有副作用，begin 会返回 row=null，后续结算自动跳过。
      let pending: Awaited<ReturnType<SideEffectLedger['begin']>> | null = null;
      // 快照失败时的说明（不阻断执行，只是记下来）
      let laterSnapshotNote: string | null = null;
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

      // ---- 快照：写文件前留一份原内容，为"撤销"提供数据 ----
      //
      // 必须在这里做（写之前），而且只在真的会写文件时做。
      // 快照失败不阻断执行——撤销是加分项，不是主流程。
      if (options.snapshots && pending?.row) {
        const target = String(args.path ?? '');
        const willWrite = name === 'write_file' || name === 'edit_file';
        if (willWrite && target) {
          try {
            const snap = await options.snapshots.save(pending.row.id, rootPath, target);
            if (!snap.saved && snap.reason) {
              // 大文件没备份：让模型知道"这次改动无法撤销"
              laterSnapshotNote = snap.reason;
            }
          } catch {
            laterSnapshotNote = '原始内容没有备份成功，这次改动可能无法撤销';
          }
        }
      } else if (name === 'write_file' || name === 'edit_file') {
        // 走到这里说明：要么没配快照、要么台账没给出记录。
        // 把原因记下来——撤销功能依赖它，静默失效最难查。
        laterSnapshotNote =
          '这次的改动没有备份原始内容，无法撤销。' +
          `（诊断：snapshots=${options.snapshots ? '有' : '无'}，pending=${pending ? (pending.row ? '有row' : 'row为空') : 'pending为空'}）`;
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
        // 通知扩展：仅用于观察，出错被吞掉。
        for (const hook of options.extensions?.afterTool ?? []) {
          try {
            hook({ tool: name, args, ok: result.ok });
          } catch {
            /* 扩展错误不影响主流程 */
          }
        }
        return result;
      };

      // 用户扩展可以否决（在审批之前：扩展是本机策略，优先级更高）。
      for (const hook of options.extensions?.beforeTool ?? []) {
        try {
          const veto = hook({ tool: name, args });
          if (veto && veto.veto) {
            return await settle(
              { ok: false, content: `被本机扩展拦截（未执行）：${veto.reason}` },
              'rejected',
            );
          }
        } catch {
          /* 扩展自己出错不卡住执行 */
        }
      }

      try {
        const result = await runTool();
        return await settle(result);

        async function runTool(): Promise<{
          ok: boolean;
          content: string;
          /**
           * Agent 主动交回任务（对齐 DSH 的 Handback）。
           *
           * 设置后 runLoop 立刻结束，状态标记为 handback 而不是 failed。
           */
          handback?: { reason: string; findings: string; suggest?: string };
        }> {
        // MCP 工具：名字形如 `<server>__<tool>`，转发给对应服务器。
        // 放在 switch 之前判断，这样新增 MCP 工具不用改 switch。
        const mcpTool = (options.mcpTools ?? []).find((t) => t.name === name);
        if (mcpTool && options.mcp) {
          return options.mcp.call(name, args);
        }

        switch (name) {
          case 'read_file': {
            const target = resolveInside(rootPath, String(args.path ?? ''));
            const content = await readFile(target, 'utf8');
            return { ok: true, content: content.slice(0, maxOutput) };
          }
          case 'find_symbol': {
            // 纯读取，只读任务里也能用
            const symbol = String(args.name ?? '').trim();
            if (!symbol) return { ok: false, content: '必须提供 name。' };

            const scopeArg = args.scope ? String(args.scope) : '.';
            const scopeRoot = resolveInside(rootPath, scopeArg);

            const result = await findSymbol(scopeRoot, symbol);
            return { ok: true, content: renderSymbolResult(symbol, result) };
          }
          case 'list_symbols': {
            const relative = String(args.path ?? '');
            const target = resolveInside(rootPath, relative);
            const symbols = await listSymbols(target);
            if (symbols.length === 0) {
              return { ok: true, content: `${relative} 里没有识别到符号定义。` };
            }
            const lines = symbols.map(
              (s) => `- 第 ${s.line} 行  [${s.kind}]  ${s.preview}`,
            );
            return {
              ok: true,
              content: [`## ${relative} 里的符号（${symbols.length} 个）`, ...lines].join('\n'),
            };
          }
          case 'use_skill': {
            // 只读操作：加载说明不改任何文件，只读任务里也能用
            const skills = options.skills ?? [];
            const wanted = String(args.name ?? '').trim();

            const found = skills.find((s) => s.name === wanted);
            if (!found) {
              const names = skills.map((s) => s.name).join(', ') || '（没有可用技能）';
              return { ok: false, content: `没有名为 ${wanted} 的技能。可用：${names}` };
            }

            const full = await loadSkill(found);
            if (!full) {
              return { ok: false, content: `技能 ${wanted} 加载失败（文件可能已被删除）。` };
            }
            if (!full.content.trim()) {
              return { ok: false, content: `技能 ${wanted} 的正文是空的。` };
            }
            return {
              ok: true,
              content: `<skill_content name="${full.name}">\n${full.content.slice(0, maxOutput)}\n</skill_content>`,
            };
          }
          case 'hand_back': {
            // **交回给 Assistant**（对齐 DSH 的 Handback）。
            //
            // 只读操作：它不改任何东西，只是表明"这活不该我干"。
            // 返回 handback 字段后，runLoop 会立刻结束本轮。
            const reason = String(args.reason ?? '').trim();
            const findings = String(args.findings ?? '').trim();

            // 必须写清理由和发现，否则交回等于白干：
            // Assistant 拿不到任何信息，还得重头查一遍。
            if (!reason || !findings) {
              return {
                ok: false,
                content:
                  '交回必须同时写清 reason（为什么不归你做）和 findings（你查到了什么）。' +
                  'Assistant 要靠 findings 决定下一步，空着等于白查一遍。',
              };
            }

            const suggest = String(args.suggest ?? '').trim();
            return {
              ok: true,
              content: '已交回给 Assistant。',
              handback: {
                reason,
                findings,
                ...(suggest ? { suggest } : {}),
              },
            };
          }
          case 'edit_file': {
            if (options.readonlyTask) {
              return {
                ok: false,
                content:
                  '这是只读任务，禁止改文件。如果你认为必须修改才能完成，' +
                  '请在收尾文本里说明需要改成写任务，不要绕过限制。',
              };
            }
            const relative = String(args.path ?? '');
            assertInScope(options.writeScope, relative);
            const target = resolveInside(rootPath, relative);

            let original: string;
            try {
              original = await readFile(target, 'utf8');
            } catch {
              return { ok: false, content: `文件不存在：${relative}。要新建请用 write_file。` };
            }

            const oldText = String(args.old_text ?? '');
            const newText = String(args.new_text ?? '');

            const applied = applyEdit(original, oldText, newText, args.replace_all === true);
            if (!applied.ok) return { ok: false, content: applied.error };

          // **算 diff**：dry_run 时不写，只返回预览
          const change = unifiedDiff(original, applied.content, { path: relative });
          const dry = args.dry_run === true;

          if (!dry) {
            await writeFile(target, applied.content, 'utf8');
          }

          return {
            ok: true,
            content:
              (dry
                ? `【预演，未写入】${relative} ${diffStat(change)}`
                : `已修改 ${relative}${applied.summary}`) +
              (laterSnapshotNote && !dry ? `\n（注意：${laterSnapshotNote}）` : '') +
              (change.text ? `\n\n${change.text}` : ''),
          };
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
          const next = String(args.content ?? '');

          // 读旧内容（新文件就是空串），算 diff
          let previous = '';
          try {
            previous = await readFile(target, 'utf8');
          } catch {
            // 新文件
          }
          const change = unifiedDiff(previous, next, { path: relative });
          const dry = args.dry_run === true;

          if (!dry) {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, next, 'utf8');
          }

          return {
            ok: true,
            content:
              (dry
                ? `【预演，未写入】${relative} ${diffStat(change)}`
                : `已写入 ${relative}（${next.length} 字）`) +
              (laterSnapshotNote && !dry ? `\n（注意：${laterSnapshotNote}）` : '') +
              (change.text ? `\n\n${change.text}` : ''),
          };
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
            const hits = await searchTree(target, query, {
              regex: args.regex === true,
              ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
              context: typeof args.context === 'number' ? args.context : 0,
              limit: 200,
            });
            return { ok: true, content: hits.join('\n') || '没有命中' };
          }
          case 'spawn_subagent': {
            // **子 Agent 需要 llm 才能跑**。没配就如实拒绝，
            // 不能让模型以为派出去了。
            if (!options.llm) {
              return {
                ok: false,
                content: '当前环境不支持派子 Agent（没有可用的模型客户端）。请自己完成这个子任务。',
              };
            }

            const depth = (options.subagentDepth ?? 0) + 1;
            const result = await runSubagent({
              llm: options.llm,
              // **子 Agent 用同样的工具集，但去掉 spawn_subagent 自己**
              // ——用 depth + 1 建一个新 host，嵌套上限在 runSubagent 里挡
              toolHost: createExecutorToolHost({
                ...options,
                subagentDepth: depth,
              }),
              task: String(args.task ?? ''),
              ...(typeof args.context === 'string' ? { context: args.context } : {}),
              signal: options.signal ?? new AbortController().signal,
              depth,
            });

            return {
              ok: result.ok,
              content: result.ok
                ? `子 Agent 的结论（${result.steps} 步）：\n${result.content}`
                : result.content,
            };
          }
          case 'read_url': {            const url = String(args.url ?? '');
            const r = await readUrl(url);
            return { ok: r.ok, content: r.content };
          }
          case 'web_search': {
            const query = String(args.query ?? '');
            const count = typeof args.count === 'number' ? Math.min(10, Math.max(1, args.count)) : 5;
            const r = await webSearch(query, options.search ?? null, { count });
            return { ok: r.ok, content: r.content };
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

            // **沙箱**：把写操作限制在项目目录内。
            //
            // 位置在审批**之前**：越界的写操作根本不该执行，
            // 不值得惊动用户去点一次"批准"。
            //
            // 注意它是**收紧**而不是放松——默认启用，不需要用户授权。
            const verdict = checkCommand(rootPath, command, {
              ...(options.allowOutside ? { allowOutside: options.allowOutside } : {}),
            });
            if (!verdict.allowed) {
              return {
                ok: false,
                content: `${verdict.reason}\n\n命中的路径：${verdict.evidence ?? '（未列出）'}`,
              };
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

              // **退出码 0 不代表测试通过**。
              //
              // 命令里有管道时（`pnpm test 2>&1 | head`），退出码是管道末端
              // 那条命令的——失败被吞掉了。模型实际用命令时经常带管道。
              //
              // 所以成功分支也要扫一眼输出里有没有失败特征。
              const looksFailed =
                /\u2716\s+failing tests:/.test(out) ||
                /^ℹ fail [1-9]/m.test(out) ||
                /\d+ failing/.test(out);

              if (looksFailed) {
                const failures = parseFailures(out);
                const judged = categorize(failures);
                return {
                  ok: false,
                  content:
                    `命令成功退出了，**但输出里有测试失败**（多半是管道吞掉了退出码）：\n` +
                    `${trimCommandOutput(out, maxOutput)}${judged}`,
                };
              }

              const failures = parseFailures(out);
              return {
                ok: true,
                content: trimCommandOutput(out, maxOutput) || '（命令无输出）',
              };
            } catch (error) {
              const err = error as { stdout?: string; stderr?: string; message?: string };
              const detail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || err.message || '';

              // **测试失败自动分类**。
              //
              // 不加这一步，模型面对 "ℹ fail 1" 只能瞎猜：重跑、改实现、改测试。
              // 改测试是最危险的——把一个真 bug 变成"测试通过"。
              // 所以这里替它做分类，并且**说明判断依据**，而不是只给结论。
              return {
                ok: false,
                content:
                  `命令失败：${trimCommandOutput(detail, maxOutput)}` +
                  // 分析结果单独截断，不能挤掉原始输出
                  categorize(parseFailures(detail)),
              };
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

/**
 * 在目录树里搜文件内容。
 *
 * 返回形如 `path:line: 内容` 的行；文件名命中则只给 `path`。
 * 上下文行用 `line-:` / `line+:` 标记。
 */
async function searchTree(
  root: string,
  query: string,
  options: { regex?: boolean; glob?: string; context?: number; limit?: number } = {},
): Promise<string[]> {
  const hits: string[] = [];
  const limit = options.limit ?? 200;
  const contextLines = Math.max(0, Math.min(5, options.context ?? 0));
  const skip = new Set(['node_modules', '.git', 'dist', '.opencoxswain', 'target']);

  // 构造匹配器：正则写错时退回字面匹配，不让一条坏正则废掉整个工具
  let matcher: (line: string) => boolean;
  if (options.regex) {
    try {
      const re = new RegExp(query, 'i');
      matcher = (line) => re.test(line);
    } catch {
      const lower = query.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lower);
    }
  } else {
    const lower = query.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(lower);
  }

  const globPattern = options.glob;
  const acceptPath = (rel: string): boolean =>
    globPattern ? matchGlob(rel, globPattern) : true;

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
        continue;
      }

      const rel = path.relative(root, full).replace(/\\/g, '/');

      // 文件名命中（只在没指定 regex/glob 时——找文件名时那两者反而碍事）
      if (!options.regex && !globPattern && rel.toLowerCase().includes(query.toLowerCase())) {
        hits.push(rel);
        if (hits.length >= limit) return;
      }

      if (!acceptPath(rel)) continue;

      // 内容匹配：只扫小的文本文件
      try {
        const info = await stat(full);
        if (info.size > 512 * 1024) continue;
        const content = await readFile(full, 'utf8');
        // 二进制文件通常含 NUL
        if (content.includes('\u0000')) continue;
        const rows = content.split('\n');

        for (let i = 0; i < rows.length && hits.length < limit; i += 1) {
          if (!matcher(rows[i] ?? '')) continue;
          hits.push(`${rel}:${i + 1}: ${(rows[i] ?? "").trim().slice(0, 200)}`);

          for (let k = 1; k <= contextLines && hits.length < limit; k += 1) {
            const before = rows[i - k];
            const after = rows[i + k];
            if (before !== undefined) hits.push(`${rel}:${i - k + 1}-: ${before.trim().slice(0, 200)}`);
            if (after !== undefined) hits.push(`${rel}:${i + k + 1}+: ${after.trim().slice(0, 200)}`);
          }
        }
      } catch {
        // 非文本文件忽略
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
  /** 可用技能（名称 + 描述）。正文由模型调 use_skill 加载。 */
  readonly skills?: readonly SkillSummary[];
  /** MCP 工具（名字带服务器前缀）。 */
  readonly mcpTools?: readonly McpTool[];
  /** MCP 调用入口。 */
  readonly mcp?: {
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
  };
  /** 只读任务：不写文件，工具层硬性拦截写入。 */
  readonly readonlyTask?: boolean;
  readonly signal: AbortSignal;
  readonly maxSteps?: number;
  readonly commandTimeoutMs?: number;
  /**
   * 联网搜索配置。
   *
   * 不传时 `web_search` 会明确告诉模型"不可用"——
   * 不能让它编造搜索结果。
   */
  readonly search?: SearchConfig | null;
  /** 中途补投的指令（C 用 message_executor 发的）。 */
  readonly drainInputs?: () => readonly string[];
  /**
   * 续聊时的既有历史（不含 system）。
   *
   * 提供后不再从"请开始执行：goal"起步，而是带着原上下文继续，
   * 把 `goal` 当作这一轮的新指令。这是"Agent 完成后还能接着聊"的实现。
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
  /**
   * 文件快照。提供后，写文件前会留一份原内容，用于事后撤销。
   *
   * 不提供就不备份——撤销功能整体不可用，但其它功能正常。
   */
  readonly snapshots?: SnapshotStore;
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
 * 跑一次Agent。
 *
 * 返回的 `finalText` 就是 Assistant 会看到的那段结论——所以提示词里反复强调
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
      ...(options.skills ? { skills: options.skills } : {}),
      ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
      ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.readonlyTask ? { readonlyTask: true } : {}),
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.ledger ? { ledger: options.ledger } : {}),
    // 快照：必须在这里也传下去。runExecutor 会自己建一个 tool host，
    // 漏了这一步的话，快照永远到不了真正的写文件逻辑。
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
    // **子 Agent 需要的三样东西**：没有 llm 就派不出去；
    // 没有 signal，父 Agent 停了子 Agent 还在跑。
    llm: options.llm,
    signal: options.signal,
    subagentDepth: 0,
    // 联网搜索配置：不传的话 web_search 会明确说"不可用"
    ...(options.search ? { search: options.search } : {}),
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
  // 只累加等模型的时间——tok/s 要用它才算得准。
  let modelMs = 0;
  let contextTokens: number | null = null;

  for await (const event of runLoop({
    llm: options.llm,
    toolHost,
    messages: messages as Parameters<typeof runLoop>[0]['messages'],
    maxSteps: options.maxSteps ?? 80,
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
      if (typeof event.modelMs === 'number') modelMs += event.modelMs;
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
    modelMs: modelMs > 0 ? modelMs : null,
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
