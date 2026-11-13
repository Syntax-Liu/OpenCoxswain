import { useEffect, useState } from 'react';
import type { DiffFile, DiffReview } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';

const STATUS_LABELS: Record<DiffFile['status'], string> = {
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  modified: '修改',
};

/**
 * 逐文件 diff 明细：对应决策说明「改了什么」，只做展开，不另写结论。
 * 大文件与二进制必须显示提示，不能静默省略。
 */
export function DiffReviewView({ taskId }: { taskId: string }): JSX.Element {
  const [review, setReview] = useState<DiffReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .diffReview(taskId)
      .then((value) => {
        if (alive) setReview(value);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  if (loading) return <p className="hint">读取逐文件改动…</p>;
  if (error) return <p className="hint danger-text">逐文件改动读取失败：{error}</p>;
  if (!review || review.files.length === 0) {
    return <p className="hint">这项任务还没有可审阅的 diff 产物。</p>;
  }

  return (
    <div className="diff-review">
      <p className="hint">
        {review.files.length} 个文件，+{review.additions} / -{review.deletions}
        {review.binary > 0 ? `，${review.binary} 个二进制` : ''}
        {review.truncated > 0 ? `，${review.truncated} 个已截断` : ''}
        {review.omitted > 0 ? `，${review.omitted} 个未列出` : ''}
      </p>
      {review.notes.map((note) => (
        <p key={note} className="hint">
          {note}
        </p>
      ))}
      <ul className="diff-files">
        {review.files.map((file) => (
          <li key={file.path}>
            <details className="diff-file">
              <summary>
                <span className={`diff-badge status-${file.status}`}>
                  {STATUS_LABELS[file.status]}
                </span>
                <span className="diff-path">
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                {file.binary ? <span className="diff-badge">二进制</span> : null}
                <span className="diff-count">
                  +{file.additions} / -{file.deletions}
                </span>
              </summary>
              {file.notice ? <p className="hint">{file.notice}</p> : null}
              {file.hunks ? <pre className="diff-body">{file.hunks}</pre> : null}
              {file.truncated ? (
                <p className="hint">以上仅为部分内容，完整改动请查看原始 diff 产物。</p>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
