/**
 * 审批闸门：不可逆动作在执行前必须由人拍板。
 *
 * 三条硬规则：
 *
 * 1. **执行前冻结，不是执行后通知**。命中危险动作时，工具**不会被真正执行**，
 *    而是先建一条待审批记录并挂起。用户批准才继续。
 *
 * 2. **超时就拒绝，不是永远挂着**。用户可能一直不在，Agent 不能无限等待——
 *    到点自动判为拒绝（`expired`），D 收到明确原因后可以继续做别的。
 *    默认 10 分钟，可配。
 *
 * 3. **拒绝要给出可读原因**。Agent 看到"用户拒绝了 rm -rf（理由：那是测试夹具）"
 *    才能调整做法；只告诉它"失败"没有意义。
 */
import { newId, type ApprovalRow, type Store } from '../store/store.js';
import type { DangerousAction } from './classify.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason: string;
  /** 从发起到决定用了多久。 */
  readonly waitedMs: number;
}

export interface ApprovalGateOptions {
  readonly store: Store;
  readonly projectId: string;
  readonly executorId: string;
  /** 自动拒绝的超时。默认 10 分钟。 */
  readonly timeoutMs?: number;
  /** 轮询间隔。审批是人工操作，不需要高频。 */
  readonly pollMs?: number;
  /** 审批记录建好后回调一次，供 IM 推送等外部通道使用。 */
  readonly onCreated?: (approvalId: string) => void;
  readonly log?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * 请求一次审批，**阻塞直到用户决定或超时**。
 *
 * 调用方（工具执行层）应当在命中危险动作时调用它，
 * 只有 `approved: true` 才真正执行动作。
 */
export async function requestApproval(
  options: ApprovalGateOptions,
  tool: string,
  args: Record<string, unknown>,
  action: DangerousAction,
): Promise<ApprovalDecision> {
  const { store } = options;
  const now = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const row: ApprovalRow = {
    id: newId('apr'),
    projectId: options.projectId,
    executorId: options.executorId,
    category: action.category,
    evidence: action.evidence,
    why: action.why,
    tool,
    args: safeJson(args),
    status: 'pending',
    decidedReason: null,
    createdAt: now,
    decidedAt: null,
    expiresAt: now + timeoutMs,
  };
  await store.putApproval(row);
  options.onCreated?.(row.id);
  options.log?.('info', `危险动作待审批：${action.category} / ${action.evidence.slice(0, 60)}`);

  const pollMs = options.pollMs ?? 500;
  for (;;) {
    await sleep(pollMs);

    const current = store.getApproval(row.id);
    if (!current) {
      return { approved: false, reason: '审批记录丢失，动作未执行', waitedMs: Date.now() - now };
    }
    if (current.status === 'approved') {
      return {
        approved: true,
        reason: current.decidedReason ?? '用户已批准',
        waitedMs: Date.now() - now,
      };
    }
    if (current.status === 'rejected') {
      return {
        approved: false,
        reason: current.decidedReason ?? '用户拒绝了该动作',
        waitedMs: Date.now() - now,
      };
    }
    if (Date.now() >= current.expiresAt) {
      // 超时自动拒绝：Agent 不该被无限挂起。
      await store.putApproval({
        ...current,
        status: 'expired',
        decidedReason: `等待审批超时（${Math.round(timeoutMs / 60000)} 分钟），已自动拒绝`,
        decidedAt: Date.now(),
      });
      return {
        approved: false,
        reason: `等待审批超时（${Math.round(timeoutMs / 60000)} 分钟），动作未执行`,
        waitedMs: Date.now() - now,
      };
    }
  }
}

/** 用户批准。 */
export async function approveAction(
  store: Store,
  approvalId: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  return decide(store, approvalId, true, reason);
}

/** 用户拒绝。 */
export async function rejectAction(
  store: Store,
  approvalId: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  return decide(store, approvalId, false, reason);
}

async function decide(
  store: Store,
  approvalId: string,
  approved: boolean,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const row = store.getApproval(approvalId);
  if (!row) return { ok: false, message: `审批 ${approvalId} 不存在` };
  if (row.status !== 'pending') {
    return { ok: false, message: `该审批已是 ${row.status}，无法再次处理` };
  }
  await store.putApproval({
    ...row,
    status: approved ? 'approved' : 'rejected',
    decidedReason: reason?.trim() || (approved ? '用户批准' : '用户拒绝'),
    decidedAt: Date.now(),
  });
  return { ok: true, message: approved ? '已批准，动作会继续执行' : '已拒绝，动作不会执行' };
}

/** 把卡住的 pending 全部置为过期（进程重启后调用）。 */
export async function expireStaleApprovals(store: Store, now = Date.now()): Promise<ApprovalRow[]> {
  const stale = store
    .listApprovals({ status: ['pending'] })
    .filter((a) => a.expiresAt <= now || true); // 重启后所有 pending 都不可能再被等待
  for (const row of stale) {
    await store.putApproval({
      ...row,
      status: 'expired',
      decidedReason: '运行时已重启，等待中的审批不再有效',
      decidedAt: now,
    });
  }
  return stale;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
