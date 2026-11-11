/**
 * 连发不打断：用户消息的投递队列。
 *
 * 用户要求（方案 §4）：
 * > "用户发送后，B 或 C 立即回复，无论回复是否载入完全，用户都可以继续发送内容，
 * >  且不打断 B 或 C。"
 *
 * dsh 已经提供了正确原语（P0-T4 已证实）：
 * - `followup` → 排成下一轮，**不打断**（默认）
 * - `steer`   → 当前轮下一步（只在"冲突且必须立刻改方向"时）
 * - `cancel`  → 真打断（只在用户点停止时）
 *
 * 本模块的价值不在重造队列，而在**把产品口径固化下来**，避免各调用点
 * 各自决定用什么投递方式：
 * 1. 用户消息默认永远 `followup`；
 * 2. 只有显式标记 `urgent` 才用 `steer`；
 * 3. 不提供"打断"的隐式路径 —— 打断必须由用户点停止触发。
 */
import type { Agent } from '../host-types.js';
import { userMessage } from '../host-types.js';

export type DeliveryMode = 'followup' | 'steer';

export interface DeliverInput {
  readonly agent: Agent;
  readonly text: string;
  /** 只有"冲突且必须立刻改方向"才置 true。默认 false。 */
  readonly urgent?: boolean;
  readonly source?: unknown;
}

export interface DeliverResult {
  readonly ok: boolean;
  readonly mode: DeliveryMode;
  readonly message: string;
}

/**
 * 投递一条用户消息。**永不打断**。
 */
export function deliver(input: DeliverInput): DeliverResult {
  const mode: DeliveryMode = input.urgent ? 'steer' : 'followup';
  const message = userMessage(input.text, input.source);

  if (mode === 'steer') {
    if (typeof input.agent.steer !== 'function') {
      // steer 不可用时**降级到 followup**，绝不退回 cancel。
      // 宁可晚一轮看到，也不要打断正在进行的工作。
      if (typeof input.agent.followup !== 'function') {
        return { ok: false, mode: 'followup', message: '该 Agent 不支持接收消息' };
      }
      input.agent.followup(message);
      return {
        ok: true,
        mode: 'followup',
        message: '宿主未提供 steer，已降级为排队到下一轮（仍然不打断）',
      };
    }
    input.agent.steer(message);
    return { ok: true, mode: 'steer', message: '已插到当前轮下一步' };
  }

  if (typeof input.agent.followup !== 'function') {
    return { ok: false, mode: 'followup', message: '该 Agent 不支持接收消息' };
  }
  input.agent.followup(message);
  return { ok: true, mode: 'followup', message: '已排队到下一轮（不打断当前这轮）' };
}

/**
 * 用户点"停止"时才调用。
 *
 * `keepInbox: true` 保留排队中的消息，避免用户点了停止就把连发的内容全丢了。
 */
export function stop(agent: Agent, reason = '用户点了停止'): { ok: boolean; message: string } {
  if (typeof agent.cancel !== 'function') {
    return { ok: false, message: '该 Agent 不支持取消' };
  }
  agent.cancel({ kind: 'user-stop', reason }, { keepInbox: true });
  return { ok: true, message: '已请求停止当前轮（排队中的消息保留）' };
}
