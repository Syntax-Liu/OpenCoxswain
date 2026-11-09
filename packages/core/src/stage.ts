import type { TaskStage, TaskStatus } from '@opencoxswain/shared';

export interface StageInput {
  status: TaskStatus;
  /** 依赖是否还有未完成项（仅对尚未开工的任务有意义）。 */
  dependencyPending: boolean;
  /** 是否有等待人回答的中途输入（G3 接入后使用）。 */
  hasPendingHumanInput?: boolean;
  /** 阻塞/失败原因，用于详情。 */
  detail?: string;
}

/**
 * 「在等谁」的计算视图：不改状态机、不落库。
 * 优先级：等人回答 > 等人验收 > 等人处理阻塞/失败 > 执行中 > 等依赖。
 */
export function computeStage(input: StageInput): TaskStage {
  const detail = input.detail ?? '';
  if (input.hasPendingHumanInput) {
    return { kind: 'person', reason: 'answer', detail };
  }
  switch (input.status) {
    case 'awaiting_review':
      return { kind: 'person', reason: 'review', detail };
    case 'awaiting_approval':
      return { kind: 'person', reason: 'review', detail: detail || '等待你确认任务单' };
    case 'blocked':
      return { kind: 'person', reason: 'blocked', detail };
    case 'failed':
      return { kind: 'person', reason: 'failed', detail };
    case 'queued':
      return input.dependencyPending
        ? { kind: 'idle', reason: 'waiting_dependency' }
        : { kind: 'working', reason: 'queued' };
    case 'running':
      return { kind: 'working', reason: 'running' };
    case 'paused':
      return { kind: 'idle', reason: 'waiting_input' };
    case 'planning':
    case 'draft':
      return { kind: 'idle', reason: 'waiting_dependency' };
    case 'done':
    case 'cancelled':
      return { kind: 'idle', reason: 'waiting_dependency' };
  }
}
