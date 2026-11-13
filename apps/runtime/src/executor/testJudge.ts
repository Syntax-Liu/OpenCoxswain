/**
 * 测试失败的分类判断。
 *
 * ## 为什么要做这个
 *
 * 半自动自进化的核心是"改完自己验证"。但 Agent 跑完测试后，
 * 面对 "ℹ fail 1" 只能：
 * - 重跑一遍（没用）
 * - 改实现（可能是错的决定）
 * - 改测试（更可能是错的）
 *
 * **它缺的不是执行，是这个判断**：这次失败到底意味着什么。
 *
 * ## 三类失败，处理方式完全不同
 *
 * | 类型 | 含义 | 该做什么 |
 * | --- | --- | --- |
 * | `implementation` | 实现不符合预期 | 改实现 |
 * | `stale-test` | 测试的预期过时了 | 改测试（**必须说明为什么**） |
 * | `environment` | 环境问题 | 修环境，重跑没用 |
 *
 * `stale-test` 是最危险的一类——**Agent 很容易把"改测试"当成捷径**，
 * 结果把一个真 bug 变成"测试通过"。所以这一类必须给出充分证据才允许判。
 *
 * ## 证据从哪来
 *
 * node:test 的失败输出里有结构化字段：`actual`、`expected`、`operator`，
 * 还有 `test at 文件:行:列` 的定位。凭这些能做出**有依据的**判断，
 * 而不是让模型凭感觉猜。
 */

export type FailureKind = 'implementation' | 'stale-test' | 'environment';

export interface ParsedFailure {
  /** 失败的测试名。 */
  readonly name: string;
  /** 断言信息（能解析出来时）。 */
  readonly assertion?: {
    readonly actual: string;
    readonly expected: string;
    readonly operator: string;
  };
  /** 失败位置（文件:行）。 */
  readonly location?: string;
  /** 错误类型（AssertionError / TypeError …）。 */
  readonly errorType?: string;
  /** 原始错误文本（截断）。 */
  readonly detail: string;
}

export interface FailureJudgment {
  readonly kind: FailureKind;
  /** 给模型看的判断依据——**必须说明为什么这么判**，不能只给结论。 */
  readonly reasoning: string;
  /** 建议的下一步。 */
  readonly suggestion: string;
}

/** 从 node:test 输出里抽出失败列表。 */
export function parseFailures(output: string): ParsedFailure[] {
  const failures: ParsedFailure[] = [];

  // node:test 的失败段从 "✖ failing tests:" 开始
  const marker = output.indexOf('✖ failing tests:');
  const section = marker >= 0 ? output.slice(marker) : output;

  // 每个失败以 "test at 文件:行:列" 开头（也兼容没有定位的情况）
  const blocks = section.split(/\ntest at /);

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    // 第一段是 "✖ failing tests:" 的表头，不是失败块
    if (i === 0) continue;
    // 分割产生的空块
    if (!block.trim()) continue;

    // 去掉 "test at " 前缀后的开头就是定位
    const locMatch = /^([^\s:]+(?::[^\s:]+)*):(\d+):(\d+)/.exec(block);
    const location = locMatch ? `${locMatch[1]}:${locMatch[2]}` : undefined;

    // 测试名：定位行后的第一个 ✖ 行
    const nameMatch = /✖\s+(.+?)\s+\([\d.]+ms\)/.exec(block);
    const name = nameMatch?.[1]?.trim();

    // 抽不到测试名的不是一条真失败（多半是噪声），跳过
    if (!name) continue;

    // 错误类型
    const errMatch = /(\w*Error)\s*(?:\[(\w+)\])?:/.exec(block);

    // 断言字段
    const actual = /actual:\s*'([^\n]*)'/.exec(block)?.[1] ??
      /actual:\s*([^\n,}]+)/.exec(block)?.[1];
    const expected = /expected:\s*'([^\n]*)'/.exec(block)?.[1] ??
      /expected:\s*([^\n,}]+)/.exec(block)?.[1];
    const operator = /operator:\s*'([^']*)'/.exec(block)?.[1];

    failures.push({
      name,
      ...(location ? { location } : {}),
      ...(errMatch?.[1] ? { errorType: errMatch[1] } : {}),
      ...(actual !== undefined && expected !== undefined && operator
        ? { assertion: { actual: actual.trim(), expected: expected.trim(), operator } }
        : {}),
      detail: block.slice(0, 600),
    });
  }

  // 兜底：抽不到结构化块时，至少把失败计数和测试名带出来
  if (failures.length === 0 && /✖/.test(output)) {
    const names = [...output.matchAll(/✖\s+(.+?)\s+\([\d.]+ms\)/g)].map((m) => m[1]!.trim());
    for (const name of names.slice(0, 20)) {
      failures.push({ name, detail: '' });
    }
  }

  return failures;
}

/**
 * 判断一次失败的性质。
 *
 * **判断顺序很重要**：先排除环境问题（最确定），再判断是不是测试过时，
 * 默认落在"实现有问题"——这是最保守的默认值。
 *
 * 保守的理由：把"实现错了"误判成"测试过时"，会让人去改测试，
 * 等于把一个真 bug 掩盖掉。反过来误判代价小得多（多查一下实现）。
 */
export function judgeFailure(failure: ParsedFailure, context: {
  /** 这次改动涉及的文件；用于判断失败位置是不是被改过。 */
  readonly changedFiles?: readonly string[];
  /** 这个测试之前是否通过过（来自上次运行记录）。 */
  readonly previouslyPassing?: boolean;
} = {}): FailureJudgment {
  const detail = failure.detail.toLowerCase();
  const errorType = (failure.errorType ?? '').toLowerCase();

  // ---- 1. 环境问题：重跑没用 ----
  if (
    /enoent|command not found|不是内部或外部命令|eacces|eperm|permission denied|econnrefused|etimedout|timeout of|eaddrinuse/.test(
      detail,
    ) ||
    errorType === 'typeerror' && /cannot read|undefined is not/.test(detail)
  ) {
    return {
      kind: 'environment',
      reasoning:
        `失败信息里有环境类错误（${failure.errorType ?? '文件/命令/网络问题'}）。` +
        '这类问题重跑不会好。',
      suggestion: '先修环境（路径、权限、依赖、被占用），再重跑。不要改代码。',
    };
  }

  if (errorType === 'error' && /cannot find module|module not found/.test(detail)) {
    return {
      kind: 'environment',
      reasoning: '找不到模块——依赖缺失，不是代码逻辑问题。',
      suggestion: '安装依赖后重跑。',
    };
  }

  // ---- 2. 测试过时：必须有充分证据 ----
  //
  // 判据（要同时满足）：
  // - 是断言失败（不是崩溃/异常）
  // - 失败位置在**测试文件**里
  // - 而且这个测试文件**这次没被改过**（否则可能是测试自己写错了）
  const isAssertion = /assertionerror/.test(errorType) || Boolean(failure.assertion);
  const locationIsTest = failure.location ? /\.(test|spec)\.[tj]sx?/.test(failure.location) : false;
  const testFileChanged = failure.location && context.changedFiles
    ? context.changedFiles.some((f) => failure.location!.startsWith(f.replace(/\\/g, '/')))
    : false;

  if (isAssertion && locationIsTest && !testFileChanged && context.previouslyPassing === true) {
    return {
      kind: 'stale-test',
      reasoning:
        `断言位置在测试文件里（${failure.location}），这个测试之前是通过的，` +
        '而这次没有改测试——所以更可能是预期过时了。\n' +
        (failure.assertion
          ? `期望 ${failure.assertion.expected}，实际 ${failure.assertion.actual}。`
          : ''),
      suggestion:
        '如果确实是需求变了：改测试的预期，**并在提交信息里写明为什么改**。' +
        '如果不是：先别改测试，回头查实现。',
    };
  }

  // ---- 3. 默认：实现有问题 ----
  return {
    kind: 'implementation',
    reasoning: failure.assertion
      ? `断言失败：期望 ${failure.assertion.expected}，实际 ${failure.assertion.actual}。` +
        (failure.location ? `\n位置：${failure.location}` : '')
      : `测试失败（${failure.errorType ?? '未知错误'}）` +
        (failure.location ? `，位置：${failure.location}` : ''),
    suggestion:
      '先读失败的测试看它守的是什么，再读实现。' +
      '**不要先改测试**——除非能说明"需求变了"。',
  };
}

/** 把判断结果渲染成给模型看的文本。 */
export function renderFailureReport(
  failures: readonly ParsedFailure[],
  judgments: readonly FailureJudgment[],
): string {
  if (failures.length === 0) return '没有失败。';

  const lines: string[] = [`## ${failures.length} 个测试失败`, ''];

  const byKind: Record<FailureKind, number> = {
    implementation: 0,
    'stale-test': 0,
    environment: 0,
  };
  for (const j of judgments) byKind[j.kind] += 1;

  lines.push(
    `分类：实现问题 ${byKind.implementation} · 测试过时 ${byKind['stale-test']} · 环境问题 ${byKind.environment}`,
  );
  lines.push('');

  for (let i = 0; i < failures.length; i += 1) {
    const f = failures[i]!;
    const j = judgments[i]!;
    lines.push(`### ${i + 1}. ${f.name}`);
    lines.push(`**判断：${j.kind}**`);
    lines.push(j.reasoning);
    lines.push(`→ ${j.suggestion}`);
    lines.push('');
  }

  return lines.join('\n');
}
