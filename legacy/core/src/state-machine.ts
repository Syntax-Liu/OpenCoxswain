import type { TaskStatus } from '@opencoxswain/shared';

export type TransitionActor = 'user' | 'scheduler' | 'worker' | 'system';

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
    readonly actor: TransitionActor,
  ) {
    super(`非法状态迁移：${from} -> ${to}（触发者：${actor}）`);
    this.name = 'InvalidTransitionError';
  }
}

const ALLOWED: Record<TaskStatus, Partial<Record<TaskStatus, TransitionActor[]>>> = {
  draft: {
    planning: ['scheduler'],
    cancelled: ['user'],
  },
  planning: {
    awaiting_approval: ['scheduler'],
    cancelled: ['user'],
  },
  awaiting_approval: {
    queued: ['user'],
    planning: ['user'],
    cancelled: ['user'],
  },
  queued: {
    running: ['scheduler'],
    failed: ['scheduler'],
    paused: ['user'],
    cancelled: ['user'],
  },
  running: {
    queued: ['scheduler', 'system'],
    awaiting_review: ['scheduler'],
    done: ['scheduler'],
    blocked: ['scheduler', 'system'],
    failed: ['scheduler', 'system'],
    paused: ['user', 'scheduler'],
    cancelled: ['user'],
  },
  awaiting_review: {
    done: ['user'],
    failed: ['user'],
    running: ['user'],
    cancelled: ['user'],
  },
  paused: {
    queued: ['user', 'scheduler'],
    running: ['user', 'scheduler'],
    cancelled: ['user'],
  },
  blocked: {
    running: ['scheduler', 'user'],
    failed: ['scheduler'],
    cancelled: ['user'],
  },
  failed: {
    queued: ['scheduler', 'user'],
    cancelled: ['user'],
  },
  done: {},
  cancelled: {},
};

export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: TransitionActor,
): boolean {
  if (from === to) return false;
  return ALLOWED[from][to]?.includes(actor) ?? false;
}

export function assertTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: TransitionActor,
): void {
  if (!canTransition(from, to, actor)) {
    throw new InvalidTransitionError(from, to, actor);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

export function canPause(status: TaskStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** 暂停时保存前置状态；只允许从 queued / running 暂停。 */
export function toPaused(status: TaskStatus): TaskStatus {
  if (!canPause(status)) {
    throw new Error(`状态 ${status} 不能暂停`);
  }
  return 'paused';
}

/** 恢复时必须回到暂停前的状态。 */
export function fromPaused(previous: TaskStatus): TaskStatus {
  if (previous !== 'queued' && previous !== 'running') {
    throw new Error(`无法恢复到前置状态 ${previous}`);
  }
  return previous;
}
