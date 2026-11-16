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
  /**
   * 这次复核的是**只读任务**吗。
   *
   * ## 2026-11-16 用户实测：只读任务被判失败
   *
   * 派一个只读 Agent 数 .md 文件，Agent 干完了，系统复核却报：
   *
   *     系统复核未通过：没有改动任何文件（只读任务）（命令失败（退出码 128））
   *
   * **只读任务本来就不该改文件。** 拿 diff（要求有改动）去验它，
   * 逻辑上就是矛盾的——它做得越对，越通不过。
   */
  readonly readonlyTask?: boolean;
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
        // **只读任务不该用 diff 验**（2026-11-16 用户实测）。
        //
        // 派只读 Agent 数 .md 文件，它干完了，复核却报
        // 「没有改动任何文件（只读任务）（命令失败（退出码 128））」。
        //
        // 只读任务本来就不许改文件，拿"必须有改动"去验它，
        // 等于做得越对越通不过。这种情况直接判通过并说明原因。
        if (options.readonlyTask) {
          results.push({
            criterion,
            verdict: 'passed',
            note: '只读任务：不改文件是预期行为，这条标准不适用',
          });
          break;
        }
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

    // **git 命令在非仓库目录里跑不了**（2026-11-16 用户实测）。
    //
    // 实况：派只读 Agent 数 .md 文件，Assistant 自己加了验收标准
    // `git status --porcelain`（想验证"没有改动任何文件"）。
    // 但那个项目不是 git 仓库，git 返回 128：
    //
    //     系统复核未通过：没有改动任何文件（只读任务）（命令失败（退出码 128））
    //
    // Agent 明明干对了，却判失败。
    //
    // 判 unverified 而不是 failed：**这不是「没做到」，是「没法验证」**。
    // 对只读任务尤其重要——它本来就不该改文件。
    if (/fatal:\s*not a git repository|not a git repo|Not a git repository/i.test(detail)) {
      return {
        criterion,
        verdict: 'unverified',
        note: '这个目录不是 git 仓库，验收命令（git …）无法执行。这不是「没做到」，是「没法验证」',
        output: detail.slice(0, 2000),
      };
    }

    // **findstr 匹配中文会因编码失败**（2026-11-16 用户实测）。
    //
    // 实况：Agent 把 ro-test.txt 改成「完全权限已修改」（确实改了），
    // Assistant 的验收命令是：
    //
    //     findstr /C:"已修改" ro-test.txt
    //
    // 退出码 1，判 failed。但内容里明明有「已修改」。
    //
    // 原因：findstr 用**系统代码页**（中文 Windows 是 GBK）去匹配，
    // 而文件是 UTF-8。两边字节完全不同，永远匹配不上。
    //
    // 实测验证：
    //     文件写 "完全权限已修改"（UTF-8 无 BOM）
    //     findstr /C:"已修改" t.txt  →  退出码 1，无输出
    //
    // 判 unverified：命令本身是好的，只是工具和编码不兼容。
    // 让用户自己看一眼文件就知道——比误判成"没做到"好。
    if (/^findstr\b/i.test(command.trim()) && /[^\x00-\x7F]/.test(command)) {
      // **换成 PowerShell 重试，而不是直接放弃**。
      //
      // findstr 用系统代码页（中文 Windows 是 GBK）去匹配 UTF-8 文件，
      // 字节对不上永远失败。但 PowerShell 能正确读 UTF-8：
      //
      //     实测同一文件：
      //       findstr /C:"已修改" t.txt        → 退出码 1（错）
      //       Select-String -Pattern "已修改"  → 匹配成功（对）
      //
      // 所以：拿 findstr 的参数转成 Select-String 再跑一次。
      // 成功了就用结果，转换不了才退回 unverified。
      const retried = await retryWithPowerShell(command, options.rootPath, timeout);
      if (retried) {
        return { criterion, ...retried };
      }
      return {
        criterion,
        verdict: 'unverified',
        note:
          'findstr 匹配中文会因代码页不匹配而失败（文件是 UTF-8，findstr 用系统代码页）。' +
          '这不是「没做到」，是「工具和编码不兼容」——请直接看文件内容确认',
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

    // **新建的文件 git diff 看不到**。
    //
    // ## 2026-11-16 用户实测踩到
    //
    // 让 Agent 在项目根目录新建 hello.cpp 并写入内容。Agent 写好了，
    // 人工核验也没问题，但系统复核报「工作区没有任何改动」，
    // 于是判失败。
    //
    // 原因：`git diff` **只比已跟踪的文件**。新建的文件是 untracked，
    // 在 diff 里根本不存在。
    //
    // 这不是边缘情况——「新建一个文件」是最常见的任务之一。
    const { stdout: untrackedRaw } = await execAsync(
      'git ls-files --others --exclude-standard',
      { cwd: options.rootPath, timeout: 30_000, windowsHide: true },
    );
    const untracked = untrackedRaw.trim().split('\n').filter(Boolean);

    if (lines.length === 0 && untracked.length === 0) {
      return {
        criterion,
        verdict: 'failed',
        note: '工作区没有任何改动——D 声称完成，但什么都没改',
      };
    }
    // 全是新文件：说清楚是新建，不是"改了 N 个文件"。
    if (lines.length === 0 && untracked.length > 0) {
      const preview = untracked.slice(0, 3).join('、');
      const more = untracked.length > 3 ? ` 等 ${untracked.length} 个` : '';
      return {
        criterion,
        verdict: 'passed',
        note: `新建了 ${untracked.length} 个文件：${preview}${more}`,
      };
    }
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      const [a, r] = line.split('\t');
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    const extra = untracked.length > 0 ? `，另新建 ${untracked.length} 个文件` : '';
    return {
      criterion,
      verdict: 'passed',
      note: `改了 ${lines.length} 个文件（+${added} / -${removed} 行）${extra}`,
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

/**
 * 把 `findstr /C:"文本" 文件` 换成 PowerShell 版重跑。
 *
 * ## 为什么需要
 *
 * findstr 用系统代码页匹配，UTF-8 文件里的中文永远匹配不上。
 * PowerShell 的 Select-String 能正确读 UTF-8。
 *
 * @returns 转换成功时返回复核结果；认不出命令形状返回 null
 */
async function retryWithPowerShell(
  command: string,
  rootPath: string,
  timeout: number,
): Promise<{ verdict: 'passed' | 'failed'; note: string; output: string } | null> {
  // 只认 `findstr /C:"xxx" file` 这一种形状，其他一律不猜。
  const m = /^findstr\s+\/C:"([^"]+)"\s+(\S+)\s*$/i.exec(command.trim());
  if (!m) return null;
  const [, pattern, file] = m;
  if (!pattern || !file) return null;

  // 用 -SimpleMatch 避免把中文里的正则元字符当语法。
  const ps = `Select-String -Path '${file.replace(/'/g, "''")}' -Pattern '${pattern.replace(/'/g, "''")}' -SimpleMatch -Quiet`;
  try {
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, {
      cwd: rootPath,
      timeout,
      windowsHide: true,
    });
    if (/true/i.test(stdout)) {
      return {
        verdict: 'passed',
        note: '命令通过（findstr 因编码不匹配失败，已用 PowerShell 复核成功）',
        output: stdout.trim().slice(0, 2000),
      };
    }
  } catch {
    // PowerShell 也失败：交给上层判 unverified
  }
  return null;
}