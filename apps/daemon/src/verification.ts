import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { verifyProvenance, extractAnchors, type ProvenanceReport } from '@opencoxswain/core';
import { newId, now } from '@opencoxswain/shared';
import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  ArtifactRef,
  DeliverableProfile,
  Evidence,
  EvidenceKind,
} from '@opencoxswain/shared';
import type { VerificationResult, VerifyInput } from '@opencoxswain/plugin-api';
import { gitCwdTooLong, longPathMessage } from './git.js';

export interface SystemVerificationOptions {
  /** 单条命令复核的超时（毫秒）。 */
  timeoutMs: number;
}

interface CommandOutcome {
  code: number;
  output: string;
}

interface DiffDetails {
  additions: number;
  deletions: number;
  paths: string[];
  patchHash: string;
  error?: string;
}

/**
 * 系统复核：command 在 worktree 内独立重跑，diff 做内容级复算，
 * rubric 按证据绑定判定；缺失证据一律 unverified 交给校验员或人。
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
    const byKind = new Map<EvidenceKind, Evidence[]>();
    const handled = new Set<string>();
    let diffVerdict: AcceptanceRecord['verdict'] | null = null;

    const addEvidence = (item: Evidence): Evidence => {
      evidence.push(item);
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
      return item;
    };

    for (const criterion of input.criteria) {
      if (criterion.type === 'command') {
        const result = await this.verifyCommand(input, criterion);
        records.push(result.record);
        if (result.evidence) addEvidence(result.evidence);
        handled.add(criterion.id);
      } else if (criterion.type === 'diff') {
        const result = await this.verifyDiff(input, criterion);
        records.push(result.record);
        addEvidence(result.evidence);
        diffVerdict = result.record.verdict;
        handled.add(criterion.id);
      } else if (
        criterion.type === 'rubric' &&
        criterion.check &&
        this.isAssertion(criterion, input.profile)
      ) {
        const result = await this.verifyAssertion(input, criterion);
        records.push(result.record);
        addEvidence(result.evidence);
        handled.add(criterion.id);
      }
    }

    const pendingRubrics = input.criteria.filter(
      (criterion) => criterion.type === 'rubric' && !handled.has(criterion.id),
    );
    const requiredKinds = new Set<EvidenceKind>(
      pendingRubrics.flatMap((criterion) => criterion.evidence_required ?? []),
    );

    let provenance: ProvenanceReport | null = null;
    if (
      requiredKinds.has('anchor') ||
      requiredKinds.has('provenance') ||
      input.profile === 'document'
    ) {
      const content = await readDeliverable(input);
      const unresolved = await unresolvedAnchors(input, content);
      provenance = verifyProvenance({ profile: input.profile, content, unresolved });
      if (provenance.anchors.length > 0) {
        addEvidence({
          id: newId('ev'),
          taskId: input.taskId,
          criterionId: pendingRubrics[0]?.id ?? 'provenance',
          kind: 'provenance',
          ref: `profile:${input.profile ?? 'document'}`,
          digest: sha256(JSON.stringify(provenance)),
          producedBy: 'system',
          createdAt: now(),
        });
        for (const anchor of provenance.anchors) {
          addEvidence({
            id: newId('ev'),
            taskId: input.taskId,
            criterionId: pendingRubrics[0]?.id ?? 'provenance',
            kind: 'anchor',
            ref: anchor,
            digest: sha256(anchor),
            producedBy: 'system',
            createdAt: now(),
          });
        }
      }
    }

    if (requiredKinds.has('diff_stat') && !byKind.has('diff_stat')) {
      const auto = await this.verifyDiff(input, {
        id: '__auto_diff',
        type: 'diff',
        desc: 'rubric 证据',
      });
      addEvidence(auto.evidence);
      if (diffVerdict === null) diffVerdict = auto.record.verdict;
    }

    if (requiredKinds.has('file')) {
      for (const relPath of artifactPaths(input.artifacts)) {
        const digest = await fileDigest(input.worktree, relPath);
        if (!digest) continue;
        addEvidence({
          id: newId('ev'),
          taskId: input.taskId,
          criterionId: pendingRubrics[0]?.id ?? 'file',
          kind: 'file',
          ref: relPath,
          digest,
          producedBy: 'system',
          createdAt: now(),
        });
      }
    }

    if (requiredKinds.has('link')) {
      const content = await readDeliverable(input);
      for (const link of extractAnchors(content ?? '').filter((ref) => /^https?:\/\//i.test(ref))) {
        addEvidence({
          id: newId('ev'),
          taskId: input.taskId,
          criterionId: pendingRubrics[0]?.id ?? 'link',
          kind: 'link',
          ref: link,
          digest: sha256(link),
          producedBy: 'system',
          createdAt: now(),
        });
      }
    }

    for (const criterion of input.criteria) {
      if (handled.has(criterion.id)) continue;
      const at = now();
      if (criterion.type === 'human') {
        records.push({
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [],
          judgedBy: 'system',
          note: '等待你逐条确认',
          at,
        });
        continue;
      }
      if (criterion.type !== 'rubric') continue;

      const required = criterion.evidence_required ?? [];
      if (required.length === 0) {
        records.push({
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [],
          judgedBy: 'system',
          note: '需要校验员或你逐条判定',
          at,
        });
        continue;
      }
      const missing = required.filter((kind) => (byKind.get(kind)?.length ?? 0) === 0);
      if (missing.length > 0) {
        records.push({
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [],
          judgedBy: 'system',
          note: `缺少证据：${missing.join('/')}`,
          at,
        });
        continue;
      }
      const anchorPending = required.includes('anchor') && provenance?.verdict === 'unverified';
      if (anchorPending) {
        records.push({
          taskId: input.taskId,
          criterionId: criterion.id,
          verdict: 'unverified',
          evidenceIds: [],
          judgedBy: 'system',
          note: `来源证据未达标：${provenance?.note ?? ''}`,
          at,
        });
        continue;
      }
      const anchorFailed = required.includes('anchor') && provenance?.verdict === 'failed';
      const diffFailed = required.includes('diff_stat') && diffVerdict === 'failed';
      const ids = required.flatMap((kind) => (byKind.get(kind) ?? []).map((item) => item.id));
      records.push({
        taskId: input.taskId,
        criterionId: criterion.id,
        verdict: anchorFailed || diffFailed ? 'failed' : 'passed',
        evidenceIds: ids,
        judgedBy: 'verifier',
        note:
          anchorFailed || diffFailed
            ? `证据复核失败：${anchorFailed ? (provenance?.note ?? '') : 'diff 内容与产物不一致'}`
            : `证据齐备（${required.join('/')}）`,
        at,
      });
    }

    return { records, evidence };
  }

  private isAssertion(criterion: AcceptanceCriterion, profile?: DeliverableProfile): boolean {
    const required = criterion.evidence_required ?? [];
    return (
      required.includes('assertion') ||
      profile === 'dataset' ||
      profile === 'ops'
    );
  }

  private async verifyAssertion(
    input: VerifyInput,
    criterion: AcceptanceCriterion,
  ): Promise<{ record: AcceptanceRecord; evidence: Evidence }> {
    const at = now();
    const outcome = await runCommand(criterion.check!, input.worktree, this.timeoutMs);
    const item: Evidence = {
      id: newId('ev'),
      taskId: input.taskId,
      criterionId: criterion.id,
      kind: 'assertion',
      ref: criterion.check!,
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
            ? excerpt(outcome.output) || '断言通过'
            : `断言失败（退出码 ${outcome.code}）：${excerpt(outcome.output)}`,
        at,
      },
    };
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
    const actual = await diffDetails(input.worktree, baseRef);
    const digest = `+${actual.additions}/-${actual.deletions};paths:${sha256(
      actual.paths.join('|'),
    ).slice(0, 12)};patch:${actual.patchHash.slice(0, 12)}`;
    const item: Evidence = {
      id: newId('ev'),
      taskId: input.taskId,
      criterionId: criterion.id,
      kind: 'diff_stat',
      ref: `git diff ${baseRef}`,
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
        additions: sum.additions + numberMeta(artifact, 'additions'),
        deletions: sum.deletions + numberMeta(artifact, 'deletions'),
        paths: [...sum.paths, ...stringArrayMeta(artifact, 'paths')],
        patchHash: sum.patchHash ?? stringMeta(artifact, 'patchHash'),
      }),
      { additions: 0, deletions: 0, paths: [] as string[], patchHash: null as string | null },
    );
    const countMatch =
      reported.additions === actual.additions && reported.deletions === actual.deletions;
    const pathMatch =
      reported.paths.length === 0 || sameSet(reported.paths, actual.paths);
    const hashMatch = !reported.patchHash || reported.patchHash === actual.patchHash;
    const matches = input.artifacts.length > 0 && countMatch && pathMatch && hashMatch;
    return {
      evidence: item,
      record: {
        taskId: input.taskId,
        criterionId: criterion.id,
        verdict: !input.artifacts.length ? 'unverified' : matches ? 'passed' : 'failed',
        evidenceIds: [item.id],
        judgedBy: 'system',
        note:
          input.artifacts.length === 0
            ? '没有可对照的交付产物'
            : matches
              ? `与产物内容一致（${digest}）`
              : `内容不一致：实际 ${digest}，产物自报 +${reported.additions}/-${reported.deletions}，路径 ${reported.paths.length} 个`,
        at,
      },
    };
  }
}

function numberMeta(artifact: ArtifactRef, key: string): number {
  const value = (artifact.meta as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' ? value : 0;
}

function stringMeta(artifact: ArtifactRef, key: string): string | null {
  const value = (artifact.meta as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : null;
}

function stringArrayMeta(artifact: ArtifactRef, key: string): string[] {
  const value = (artifact.meta as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function artifactPaths(artifacts: ArtifactRef[]): string[] {
  return [...new Set(artifacts.flatMap((artifact) => stringArrayMeta(artifact, 'paths')))];
}

function sameSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

async function readDeliverable(input: VerifyInput): Promise<string | null> {
  for (const relPath of artifactPaths(input.artifacts)) {
    const absolute = path.resolve(input.worktree, relPath);
    if (!isWithin(input.worktree, absolute)) continue;
    try {
      return await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
  }
  return input.deliverableText ?? null;
}

async function fileDigest(worktree: string, relPath: string): Promise<string | null> {
  const absolute = path.resolve(worktree, relPath);
  if (!isWithin(worktree, absolute)) return null;
  try {
    return sha256(await readFile(absolute, 'utf8'));
  } catch {
    return null;
  }
}

async function unresolvedAnchors(
  input: VerifyInput,
  content: string | null,
): Promise<string[]> {
  if (!content) return [];
  const unresolved: string[] = [];
  for (const anchor of extractAnchors(content)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(anchor)) continue;
    const [file, fragment] = anchor.split('#');
    if (!file) continue;
    const absolute = path.resolve(input.worktree, file);
    if (!isWithin(input.worktree, absolute)) {
      unresolved.push(anchor);
      continue;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        unresolved.push(anchor);
        continue;
      }
      const range = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment ?? '');
      if (range) {
        const lines = (await readFile(absolute, 'utf8')).split(/\r?\n/).length;
        const end = Number(range[2] ?? range[1]);
        if (end > lines) unresolved.push(anchor);
      }
    } catch {
      unresolved.push(anchor);
    }
  }
  return unresolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
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

function diffDetails(cwd: string, baseRef: string): Promise<DiffDetails> {
  return new Promise((resolve) => {
    const numstat = spawn('git', ['-c', 'core.quotepath=false', 'diff', '--numstat', baseRef], {
      cwd,
      windowsHide: true,
    });
    let numstatOut = '';
    let stderr = '';
    numstat.stdout?.on('data', (chunk: Buffer) => {
      numstatOut += chunk.toString('utf8');
    });
    numstat.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    numstat.on('error', (error) =>
      resolve({ additions: 0, deletions: 0, paths: [], patchHash: '', error: error.message }),
    );
    numstat.on('close', (code) => {
      if (code !== 0) {
        resolve({
          additions: 0,
          deletions: 0,
          paths: [],
          patchHash: '',
          error: stderr.trim() || `git 退出码 ${code}`,
        });
        return;
      }
      void collectNamesAndPatch(cwd, baseRef, numstatOut).then(resolve);
    });
  });
}

async function collectNamesAndPatch(
  cwd: string,
  baseRef: string,
  numstatOut: string,
): Promise<DiffDetails> {
  let additions = 0;
  let deletions = 0;
  for (const line of numstatOut.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    if (match[1] !== '-') additions += Number(match[1]);
    if (match[2] !== '-') deletions += Number(match[2]);
  }
  const names = await gitOutput(cwd, ['diff', '--name-only', baseRef]);
  if (names.error) {
    return { additions, deletions, paths: [], patchHash: '', error: names.error };
  }
  const patch = await gitOutput(cwd, ['diff', baseRef]);
  if (patch.error) {
    return { additions, deletions, paths: [], patchHash: '', error: patch.error };
  }
  return {
    additions,
    deletions,
    paths: names.output.split(/\r?\n/).filter(Boolean),
    patchHash: sha256(patch.output),
  };
}

function gitOutput(cwd: string, args: string[]): Promise<{ output: string; error?: string }> {
  if (gitCwdTooLong(cwd)) {
    return Promise.resolve({ output: '', error: longPathMessage(cwd) });
  }
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args], {
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
    child.on('error', (error) => resolve({ output: '', error: error.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ output: '', error: stderr.trim() || `git 退出码 ${code}` });
        return;
      }
      resolve({ output });
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
