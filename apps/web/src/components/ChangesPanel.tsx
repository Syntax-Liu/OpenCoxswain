/**
 * 右栏「改动」页签：最近几轮 Agent 改了什么。
 *
 * ## 为什么这里只是个列表
 *
 * 用户反馈：右栏里内联展开的 Diff「和 DSH 差太多了」。
 * 确实——右栏只有三百来像素，双栏对比挤在那儿没法读。
 *
 * 现在这里只负责**选**，点一条就在主区开一个改动标签：
 *
 *   │ 第 240 轮改动 × │ OpenCoxswain 0.116.2 │
 *
 * 主区有整个宽度，双栏才排得下。
 *
 * ## 为什么按 Agent 分组
 *
 * 数据模型里**一轮 = 一次派活（一个 Agent）**，改动天然挂在
 * `executor_id` 上。所以列表就是"最近几个 Agent"，
 * 与 DSH 的「第 N 轮改动」是同一语义。
 */
import type { ApiClient, ExecutorDto } from '../api.js';
import { ListItem } from '../ui/index.js';

export interface ChangesPanelProps {
  readonly api: ApiClient;
  /** 项目里的 Agent（含已完成的）。 */
  readonly executors: readonly ExecutorDto[];
  /**
   * 点某个 Agent 时打开它的改动页（在主区开标签）。
   */
  readonly onOpenChanges: (executorId: string) => void;
}

const STATUS_TEXT: Record<string, string> = {
  done: '已完成',
  handback: '已交回',
  failed: '未完成',
  running: '进行中',
  starting: '启动中',
  cancelled: '已取消',
};

export function ChangesPanel(props: ChangesPanelProps): JSX.Element {
  // 最近 20 个 Agent，新的在上。
  const candidates = [...props.executors]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);

  if (candidates.length === 0) {
    return <p className="rail-empty-text">还没有跑过的 Agent。</p>;
  }

  return (
    <div className="changes">
      <ul className="changes-list">
        {candidates.map((e) => (
          <li key={e.id}>
            <ListItem onClick={() => props.onOpenChanges(e.id)} title={e.goal} variant={"changes-item"}><span className="changes-label">{e.label}</span><span className="changes-meta">{STATUS_TEXT[e.status] ?? e.status}</span></ListItem>
          </li>
        ))}
      </ul>
    </div>
  );
}
