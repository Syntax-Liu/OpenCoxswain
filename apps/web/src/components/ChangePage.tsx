/**
 * 主区「改动」页（照 DSH）。
 *
 * ## 布局
 *
 *   ┌─ 文件列表 ─┬─ Diff 双栏 ──────────┐
 *   │ a/x.json   │  @@ -1,6 +1,6 @@    │
 *   │   +1 -1    │  3 "0.116.2" │ 绿    │
 *   │ b/y.ts     │                       │
 *   │   +5 -0    │                       │
 *   └────────────┴───────────────────────┘
 *
 * 左侧固定宽度、可滚；右侧占满剩余宽度。**不是塞在右栏里**——
 * 右栏只有三百来像素，双栏 Diff 在那儿根本没法读。
 *
 * ## 为什么左侧列出全部文件而不是下拉
 *
 * 一轮改动常有十几个文件。下拉要点两次才看到，列表一眼看全，
 * 而且每条带 `+N -M`，能直接看出哪個文件改得多。
 */
import { useEffect, useMemo, useState } from 'react';

import type { ApiClient, DiffFileDto, ExecutorDto } from '../api.js';
import { diffLines, diffStats, toHunks } from './diff.js';
import { Button, ListItem } from '../ui/index.js';

export interface ChangePageProps {
  readonly api: ApiClient;
  /** 这一轮对应的 Agent。 */
  readonly executor: ExecutorDto;
  /** 第几轮（由外部按打开顺序编号）。 */
  readonly roundNo: number;
  readonly onClose: () => void;
}

const STATUS_TEXT: Record<DiffFileDto['status'], string> = {
  added: '新建',
  modified: '修改',
  removed: '删除',
  unknown: '未知',
};

export function ChangePage(props: ChangePageProps): JSX.Element {
  const [files, setFiles] = useState<readonly DiffFileDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    props.api
      .executorDiff(props.executor.id)
      .then((r) => {
        if (!alive) return;
        setFiles(r.files);
        setSelected(r.files[0]?.path ?? null);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : '读取改动失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [props.api, props.executor.id]);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of files) {
      const s = diffStats(diffLines(f.before, f.after));
      added += s.added;
      removed += s.removed;
    }
    return { added, removed };
  }, [files]);

  const current = files.find((f) => f.path === selected) ?? null;

  return (
    <div className="change-page">
      {/* 顶部：这是哪一轮、改了多少 */}
      <header className="change-head">
        <div className="change-head-main">
          <h1 className="change-title">
            第 {props.roundNo} 轮改动
            <span className="change-agent">{props.executor.label}</span>
          </h1>
          <p className="change-summary">
            {files.length} 个文件，
            <span className="diff-add"> +{totals.added}</span>
            <span className="diff-del"> -{totals.removed}</span>
          </p>
        </div>
        <Button onClick={props.onClose} variant="secondary">关闭
        </Button>
      </header>

      {loading && <p className="rail-empty-text">读取中…</p>}
      {error && <p className="rail-empty-text">{error}</p>}

      {!loading && !error && files.length === 0 && (
        <p className="rail-empty-text">这一轮没有改动任何文件。</p>
      )}

      {!loading && !error && files.length > 0 && (
        <div className="change-body">
          {/* 左：文件列表 */}
          <aside className="change-files">
            <ul>
              {files.map((f) => {
                const s = diffStats(diffLines(f.before, f.after));
                return (
                  <li key={f.path}>
                    <ListItem onClick={() => setSelected(f.path)} title={f.path} variant={"change-file"}><span className="change-file-name">{f.path}</span><span className="change-file-stat">
                        <span className="diff-add">+{s.added}</span>
                        <span className="diff-del">-{s.removed}</span>
                      </span></ListItem>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* 右：双栏 Diff */}
          <section className="change-diff">
            {current && <DiffBody file={current} />}
          </section>
        </div>
      )}
    </div>
  );
}

/** 单个文件的双栏对比，带 hunk 头。 */
function DiffBody(props: { file: DiffFileDto }): JSX.Element {
  const hunks = useMemo(
    () => toHunks(diffLines(props.file.before, props.file.after)),
    [props.file],
  );

  return (
    <>
      <div className="change-diff-head">
        <span className="diff-path">{props.file.path}</span>
        <span className="change-status">{STATUS_TEXT[props.file.status]}</span>
      </div>

      {props.file.before === null && props.file.after === null ? (
        // **读不到 ≠ 空文件**：得让用户知道是我们看不到，不是内容被清空了
        <p className="rail-empty-text">内容读不到（可能过大或已删除）。</p>
      ) : hunks.length === 0 ? (
        <p className="rail-empty-text">内容没有变化。</p>
      ) : (
        <div className="change-diff-body">
          {hunks.map((hunk, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{hunk.header}</div>
              {hunk.lines.map((line, li) => (
                <div key={li} className={`diff-row kind-${line.kind}`}>
                  <span className="diff-no">{line.leftNo ?? ''}</span>
                  <span className="diff-cell">
                    {line.left === null ? null : line.left === '' ? '\u00a0' : line.left}
                  </span>
                  <span className="diff-no">{line.rightNo ?? ''}</span>
                  <span className="diff-cell">
                    {line.right === null ? null : line.right === '' ? '\u00a0' : line.right}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
