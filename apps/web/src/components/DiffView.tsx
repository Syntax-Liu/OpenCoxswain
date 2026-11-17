/**
 * 双栏 Diff：左"改之前"、右"改之后"，行级高亮。
 *
 * 照 DeepSeek Harness 的改动视图：左右并排、行号对齐、
 * 增行绿底、删行红底、改行左右都标色。
 *
 * ## 为什么不用库
 *
 * 只做"看"，不做"编辑 / 应用"。十行 CSS + 一个 LCS 就够，
 * 引依赖反而要处理它的样式覆盖。
 */
import type { DiffFileDto } from '../api.js';
import { diffLines, diffStats } from './diff.js';
import { OptionItem } from '../ui/index.js';

export interface DiffViewProps {
  readonly files: readonly DiffFileDto[];
  /** 当前选中的文件路径；不传就显示第一个。 */
  readonly selected?: string;
  readonly onSelect?: (path: string) => void;
}

/**
 * 内容读不到时的提示。
 *
 * **必须和"空文件"区分开**：空文件是「这个文件现在没内容」，
 * 读不到是「我们看不到」——两者对用户的含义完全不同。
 */
function Unavailable(props: { what: 'before' | 'after' }): JSX.Element {
  return (
    <div className="diff-unavailable">
      {props.what === 'before' ? '（改动前的内容读不到）' : '（当前内容读不到或已删除）'}
    </div>
  );
}

/** 一个文件的并排对比。 */
function FileDiff(props: { file: DiffFileDto }): JSX.Element {
  const lines = diffLines(props.file.before, props.file.after);
  const stats = diffStats(lines);

  return (
    <div className="diff-file">
      <div className="diff-file-head">
        <span className="diff-path">{props.file.path}</span>
        <span className="diff-stat">
          <span className="diff-add">+{stats.added}</span>
          <span className="diff-del">-{stats.removed}</span>
        </span>
      </div>

      {props.file.before === null && props.file.after === null ? (
        <Unavailable what="after" />
      ) : (
        <div className="diff-body">
          {lines.map((line, i) => (
            <div key={i} className={`diff-row kind-${line.kind}`}>
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
      )}
    </div>
  );
}

export function DiffView(props: DiffViewProps): JSX.Element {
  if (props.files.length === 0) {
    return <p className="rail-empty-text">这个 Agent 没有改动任何文件。</p>;
  }

  // 一次只显示一个文件的并排对比；改多个文件时上面给一排可点的标签。
  const current = props.files.find((f) => f.path === props.selected) ?? props.files[0]!;

  return (
    <div className="diff-view">
      {props.files.length > 1 && (
        <div className="diff-file-tabs">
          {props.files.map((f) => (
            <OptionItem
              key={f.path}
              variant="diff-file-tab"
              selected={f.path === current.path}
              onClick={() => props.onSelect?.(f.path)}
            >
              {f.path}
            </OptionItem>
          ))}
        </div>
      )}
      <FileDiff file={current} />
    </div>
  );
}

/** 一组文件的合计增删（页签徽标用）。 */
export function totalStats(files: readonly DiffFileDto[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    const s = diffStats(diffLines(f.before, f.after));
    added += s.added;
    removed += s.removed;
  }
  return { added, removed };
}
