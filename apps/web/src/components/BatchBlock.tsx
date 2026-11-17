import type { ExecutorDto } from '../api.js';
import {
  describeBatch,
  statusDotClass,
  toTaskLine,
  type Batch,
} from './batches.js';
import { ListItem } from '../ui/index.js';

/**
 * 批次线：本产品的签名元素。
 *
 * ```
 * ══ 03:14 · 派出 3 个 · 2 个已完成 ══════════
 *  ● 查依赖漏洞        完成   0:51    ← 先完成先上
 *  ● 重构登录页        进行中
 *  ○ 补测试            排队
 * ```
 *
 * 为什么它重要：这个产品最核心的机制是「一句话派多个 Agent，
 * 谁先完成谁先报」。批次线把这套机制变成**看得见的结构**，
 * 而不只是时间流水。
 *
 * 点任意一行进入那个 Agent 的完整对话。
 */
export interface BatchBlockProps {
  readonly batch: Batch;
  readonly onOpen: (executorId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  done: '完成',
  running: '进行中',
  queued: '排队',
  blocked: '等你',
};

export function BatchBlock(props: BatchBlockProps): JSX.Element {
  const { time, summary } = describeBatch(props.batch);

  return (
    <div className="batch-block">
      <div className="batch-line">
        <span className="batch-rule" aria-hidden />
        <span className="batch-meta">
          <span className="batch-time">{time}</span>
          <span className="batch-summary">{summary}</span>
        </span>
        <span className="batch-rule" aria-hidden />
      </div>

      <ul className="batch-tasks">
        {props.batch.agents.map((agent) => {
          const line = toTaskLine(agent);
          return (
            <li key={agent.id}>
              <ListItem
                variant="batch-task"
                extraStatus={line.status}
                onClick={() => props.onOpen(agent.id)}
                title={agent.goal}
              >
                <span className={`batch-dot ${statusDotClass(line.status)}`} aria-hidden />
                <span className="batch-task-label">{line.label}</span>
                <span className="batch-task-status">{STATUS_LABEL[line.status] ?? ''}</span>
                <span className="batch-task-duration">{line.duration ?? ''}</span>
              </ListItem>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 找某个 Agent 所在的批次（用于在对话流里定位）。 */
export function findBatchOf(batches: readonly Batch[], executorId: string): Batch | null {
  return batches.find((b) => b.agents.some((a) => a.id === executorId)) ?? null;
}

/** 供外部复用的类型。 */
export type { Batch };
export type { ExecutorDto };
