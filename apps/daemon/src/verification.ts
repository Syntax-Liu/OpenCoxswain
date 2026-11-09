import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { newId, now } from '@opencoxswain/shared';
import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  ArtifactRef,
  Evidence,
} from '@opencoxswain/shared';
import type { VerificationResult, VerifyInput } from '@opencoxswain/plugin-api';

export interface SystemVerificationOptions {
  /** 单条命令复核的超时（毫秒）。 */
  timeoutMs: number;
}

interface CommandOutcome {
  code: number;
  output: string;
}

/**
 * 系统复核：command 在本机 worktree 内独立重跑，diff 用 git 复算，
 * rubric / human 一律标记为 unverified 交给校验员或人。
 * 不读取执行者的自报结论。
 */
export class SystemVerification {
  private readonly timeoutMs: number;

  constructor(options: SystemVerificationOptions) {
    this.timeoutMs = options.timeoutMs;
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const records: AcceptanceRecord[] = [];
    const evidence: Evidence[] = [];

    for (const criterion of input.criteria) {
      if (criterion.type === 'command') {
        const result = await this.verifyCommand(input, criterion);
        records.push(result.record);
        if (result.evidence) evidence.push(result.evidence);
      } else if (criterion.type === 'diff') {
        const result = await this.verifyDiff(input, criterion);
        records.push(result.record);
        evidence.push(result.evidence);
      } else {
        records.push({
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [],
          judgedBy: 'system',
          note:
            criterion.type === 'rubric'
              ? '需要校验员或你逐条判定'
              : '等待你逐条确认',
          at: now(),
        });
      }
    }

    return { records, evidence };
  }

  private async verifyCommand(
    input: VerifyInput,
    criterion: AcceptanceCriterion,
  ): Promise<{ record: AcceptanceRecord; evidence?: Evidence }> {
    const at = now();
    if (!criterion.check) {
      return {
        record: {
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'failed',
          evidenceIds: [],
          judgedBy: 'system',
          note: 'command 验收缺少 check 命令',
          at,
        },
      };
    }
    const outcome = await runCommand(criterion.check, input.worktree, this.timeoutMs);
    const item: Evidence = {
      id: newId('ev'),
      taskId: input.taskId,
      criterionId: criterion.id,
      kind: 'command_output',
      ref: criterion.check,
      digest: `exit:${outcome.code};${sha256(outcome.output).slice(0, 16)}`,
      producedBy: 'system',
      createdAt: at,
    };
    return {
      evidence: item,
      record: {
        taskId: input.taskId,
        criterionId: criterion.id,
        verdict: outcome.code === 0 ? 'passed' : 'failed',
        evidenceIds: [item.id],
        judgedBy: 'system',
        note:
          outcome.code === 0
            ? excerpt(outcome.output) || '命令通过，无输出'
            : `退出码 ${outcome.code}：${excerpt(outcome.output)}`,
        at,
      },
    };
  }

  private async verifyDiff(
    input: VerifyInput,
    criterion: AcceptanceCriterion,
  ): Promise<{ record: AcceptanceRecord; evidence: Evidence }> {
    const at = now();
    const baseRef = input.baseRef ?? 'HEAD';
    const actual = await diffStat(input.worktree, baseRef);
    const digest = `+${actual.additions}/-${actual.deletions}`;
    const item: Evidence = {
      id: newId('ev'),
      taskId: input.taskId,
      criterionId: criterion.id,
      kind: 'diff_stat',
      ref: `git diff --numstat ${baseRef}`,
      digest,
      producedBy: 'system',
      createdAt: at,
    };

    if (actual.error) {
      return {
        evidence: item,
        record: {
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [item.id],
          judgedBy: 'system',
          note: `diff 复算失败：${actual.error}`,
          at,
        },
      };
    }

    const reported = input.artifacts.reduce(
      (sum, artifact) => ({
        additions: sum.additions + (artifact.meta?.additions ?? 0),
        deletions: sum.deletions + (artifact.meta?.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    );
    const matches =
      input.artifacts.length > 0 &&
      reported.additions === actual.additions &&
      reported.deletions === actual.deletions;
    return {
      evidence: item,
      record: {
        taskId: input.taskId,
        criterionId: criterion.id,
        verdict: matches ? 'passed' : 'unverified',
        evidenceIds: [item.id],
        judgedBy: 'system',
        note:
          input.artifacts.length === 0
            ? '没有可对照的交付产物'
            : matches
              ? `与产物统计一致（${digest}）`
              : `实际 ${digest}，产物自报 +${reported.additions}/-${reported.deletions}`,
        at,
      },
    };
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    const append = (chunk: Buffer): void => {
      if (output.length < 20000) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${error.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

function diffStat(
  cwd: string,
  baseRef: string,
): Promise<{ additions: number; deletions: number; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['diff', '--numstat', baseRef], {
      cwd,
      windowsHide: true,
    });
    let output = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ additions: 0, deletions: 0, error: error.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ additions: 0, deletions: 0, error: stderr.trim() || `git 退出码 ${code}` });
        return;
      }
      let additions = 0;
      let deletions = 0;
      for (const line of output.split('\n')) {
        const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!match) continue;
        if (match[1] !== '-') additions += Number(match[1]);
        if (match[2] !== '-') deletions += Number(match[2]);
      }
      resolve({ additions, deletions });
    });
  });
}

function excerpt(output: string): string {
  const single = output.replace(/\s+/g, ' ').trim();
  return single.length > 300 ? `${single.slice(0, 300)}…` : single;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
