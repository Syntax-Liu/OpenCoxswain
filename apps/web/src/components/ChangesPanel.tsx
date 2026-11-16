/**
 * 右栏「改动」页签：最近几轮 Agent 改了什么。
 *
 * ## 为什么按 Agent 分组
 *
 * 数据模型里**一轮 = 一次派活（一个 Agent）**，改动天然挂在
 * `executor_id` 上。所以列表就是"最近几个 Agent + 它改了几个文件"，
 * 与 DSH 的「第 N 轮改动」是同一语义。
 *
 * ## 为什么点进去才拉 Diff
 *
 * Diff 要把文件内容整段读出来。列表阶段只显示条数，
 * 用户点了才拉——否则一进右栏就为所有 Agent 读一遍磁盘。
 */
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient, DiffFileDto, ExecutorDto } from '../api.js';
import { DiffView } from './DiffView.js';

export interface ChangesPanelProps {
  readonly api: ApiClient;
  /** 项目里的 Agent（含已完成的）。 */
  readonly executors: readonly ExecutorDto[];
  readonly onOpenExecutor?: (id: string) => void;
}

const STATUS_LABEL: Record<DiffFileDto['status'], string> = {
  added: '新建',
  modified: '修改',
  removed: '删除',
  unknown: '未知',
};

export function ChangesPanel(props: ChangesPanelProps): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly DiffFileDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  // 只看**改动过文件**的 Agent，最近在前。
  const candidates = [...props.executors]
    .filter((e) => e.status === 'done' || e.status === 'failed' || e.status === 'handback')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      setSelected(undefined);
      try {
        const result = await props.api.executorDiff(id);
        setFiles(result.files);
      } catch (e) {
        setError(e instanceof Error ? e.message : '读取改动失败');
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [props.api],
  );

  useEffect(() => {
    if (openId) void load(openId);
    else setFiles([]);
  }, [openId, load]);

  if (candidates.length === 0) {
    return <p className="rail-empty-text">还没有跑完的 Agent。</p>;
  }

  return (
    <div className="changes">
      <ul className="changes-list">
        {candidates.map((e) => {
          const open = e.id === openId;
          return (
            <li key={e.id}>
              <button
                type="button"
                className={`changes-item${open ? ' open' : ''}`}
                onClick={() => setOpenId(open ? null : e.id)}
              >
                <span className="changes-label">{e.label}</span>
                <span className="changes-meta">
                  {e.status === 'done' ? '已完成' : e.status === 'handback' ? '已交回' : '未完成'}
                </span>
              </button>
              {open && (
                <div className="changes-detail">
                  {loading && <p className="rail-empty-text">读取中…</p>}
                  {error && <p className="rail-empty-text">{error}</p>}
                  {!loading && !error && (
                    <DiffView
                      files={files}
                      {...(selected !== undefined ? { selected } : {})}
                      onSelect={setSelected}
                    />
                  )}
                  {props.onOpenExecutor && (
                    <button
                      type="button"
                      className="btn btn--link changes-open"
                      onClick={() => props.onOpenExecutor?.(e.id)}
                    >
                      打开这一轮
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 文件状态标签（其他地方也能用）。 */
export function diffStatusLabel(status: DiffFileDto['status']): string {
  return STATUS_LABEL[status];
}
