/**
 * 系统独立复核。
 *
 * 关键：**由我们跑，不是听 D 说**。
 *
 * - `command`：在项目目录里重新执行，只看退出码；
 * - `diff`：统计工作区相对基线的改动（需要项目是 git 仓库）；
 * - `human`：交给人。
 *
 * 复核命令**同样经过危险动作闸门**——否则 D 可以在验收标准里写
 * `rm -rf .`，验收时会真的执行，等于绕过 A2。
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
  combineVerdicts,
  needsHumanReview,
  type AcceptancePolicy,
  type AcceptanceResult,
  type Criterion,
  type CriterionResult,
} from './criteria.js';
import {
  checkCommandUsable,
  firstProgramOf,
  looksLikeCommandNotFound,
} from './portability.js';

const execAsync = promisify(exec);

export interface VerifyOptions {
  readonly rootPath: string;
  readonly criteria: readonly Criterion[];
  readonly policy: AcceptancePolicy;
  /** 默认 120s。 */
  readonly defaultTimeoutMs?: number;
  /**
   * 危险动作闸门。**必须提供**——验收命令若不经过它，
   * 就等于给 Agent 开了一个绕过审批执行任意命令的后门。
   */
  readonly approve: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
  /** 基线提交（用于 diff）。不提供则 diff 类标准判 unverified。 */
  readonly baseline?: string;
}

/** 跑一次验收复核。 */
export async function verify(options: VerifyOptions): Promise<AcceptanceResult> {
  const results: CriterionResult[] = [];

  for (const criterion of options.criteria) {
    switch (criterion.type) {
      case 'command':
        results.push(await verifyCommand(options, criterion));
        break;
      case 'diff':
        results.push(await verifyDiff(options, criterion));
        break;
      case 'human':
        results.push({
          criterion,
          verdict: 'unverified',
          note: '需要人确认',
        });
        break;
    }
  }

  const verdict = combineVerdicts(results);
  return {
    verdict,
    results,
    // 失败的项不允许人工覆盖，所以只有非 failed 时才谈"是否需要人看"
    needsHuman: verdict !== 'failed' && needsHumanReview(options.policy, results),
  };
}

async function verifyCommand(
  options: VerifyOptions,
  criterion: Criterion,
): Promise<CriterionResult> {
  const command = criterion.check ?? '';
  if (!command) {
    return { criterion, verdict: 'failed', note: 'command 类标准缺少 check 命令' };
  }

  // **事前**：命令在本平台语法上就跑不了，不必执行。
  //
  // 实测（2026-11-15）：Windows 上 `test -f` / `grep` 不存在，退出码非 0，
  // 会被当成「检查没通过」。用户看到「文件不存在」，其实文件在。
  // 判 unverified 而不是 failed：这不是「做错了」，是「没法验证」。
  const usable = checkCommandUsable(command);
  if (!usable.usable) {
    return {
      criterion,
      verdict: 'unverified',
      note: `验收命令在当前平台无法执行：${usable.reason ?? '不可用'}`,
    };
  }

  // 复核命令也要过审批闸门：否则"验收"成了执行任意命令的后门。
  const decision = await options.approve('run_command', { command });
  if (!decision.approved) {
    return {
      criterion,
      verdict: 'failed',
      note: `复核命令未获批准，无法验证：${decision.reason}`,
    };
  }

  const timeout = criterion.timeoutMs ?? options.defaultTimeoutMs ?? 120_000;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.rootPath,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${stdout}\n${stderr}`.trim().slice(0, 2000);
    return {
      criterion,
      verdict: 'passed',
      note: `命令通过（退出码 0）`,
      output,
    };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    const detail = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || err.message || '';

    // **事后**：命令跑挂了，先分清是「程序不存在」还是「检查没过」。
    //
    // 二者对用户的含义完全不同：
    //   - 检查没过 → Agent 没做到（failed，正确）
    //   - 程序不存在 → 验收命令写错平台，Agent 可能是对的（unverified）
    // 混为一谈会让所有验收安静地变红，看起来像 Agent 什么都没干。
    if (looksLikeCommandNotFound(err.stderr ?? detail)) {
      const program = firstProgramOf(command);
      return {
        criterion,
        verdict: 'unverified',
        note: `验收命令依赖的程序在本机不存在：${program || '未知'}。这不是「没做到」，是「没法验证」`,
        output: detail.slice(0, 2000),
      };
    }

    return {
      criterion,
      verdict: 'failed',
      note: `命令失败（退出码 ${String(err.code ?? 'nonzero')}）`,
      output: detail.slice(0, 2000),
    };
  }
}

async function verifyDiff(
  options: VerifyOptions,
  criterion: Criterion,
): Promise<CriterionResult> {
  try {
    // 统计工作区相对基线的改动行数。
    const base = options.baseline ? [options.baseline] : [];
    const { stdout } = await execAsync(
      ['git', 'diff', '--numstat', ...base, ...(base.length ? [] : ['HEAD'])].join(' '),
      { cwd: options.rootPath, timeout: 30_000, windowsHide: true },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return {
        criterion,
        verdict: 'failed',
        note: '工作区没有任何改动——D 声称完成，但什么都没改',
      };
    }
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      const [a, r] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    return {
      criterion,
      verdict: 'passed',
      note: `改了 ${lines.length} 个文件（+${added} / -${removed} 行）`,
      output: lines.slice(0, 50).join('\n'),
    };
  } catch (error) {
    return {
      criterion,
      verdict: 'unverified',
      note: `无法统计改动（项目可能不是 git 仓库）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
