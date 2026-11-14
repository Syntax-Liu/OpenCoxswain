/**
 * 右侧栏（照 DSH）。
 *
 * ## 为什么从顶部挪到这里
 *
 * 决策面板原来在对话区上方，实测占主区 26%（228px / 870px）。
 * 用户的反馈很直接：
 *
 * > 放在顶上导致下方对话很扁，看不全内容
 *
 * 而且展开时还能占到 32vh，消息区被压到 370px——
 * 一个两万像素的长对话只剩不到三分之一屏。
 *
 * ## 结构
 *
 * 右栏是**纵向分区**，每块可折叠：
 *
 *   ┌─ 待决策 (n) ─────────┐
 *   ├─ 工作区文件 ─────────┤
 *   ├─ 快捷操作 ───────────┤
 *   └──────────────────────┘
 *
 * 决策面板放在最上面：它是最需要用户动脑的，
 * 但**不再占对话的垂直空间**——它有自己的宽度。
 */
import { type ReactNode, useState } from 'react';

export interface RightRailProps {
  /** 待决策面板（传 null 表示没有）。 */
  readonly decisions?: ReactNode;
  /** 工作区文件区。 */
  readonly files?: ReactNode;
  /** 快捷操作区。 */
  readonly actions?: ReactNode;
  /** 关闭右栏。 */
  readonly onClose?: () => void;
  /** 决策条数，显示在标题上。 */
  readonly decisionCount?: number;
}

/** 一个可折叠的分区。 */
function Section(props: {
  title: string;
  badge?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className={`rail-section${open ? ' open' : ''}`}>
      <button
        type="button"
        className="rail-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="rail-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="rail-title">{props.title}</span>
        {props.badge !== undefined && props.badge > 0 && (
          <span className="rail-badge">{props.badge}</span>
        )}
      </button>
      {open && <div className="rail-body">{props.children}</div>}
    </section>
  );
}

export function RightRail(props: RightRailProps): JSX.Element {
  return (
    <aside className="rail" aria-label="侧边栏">
      <div className="rail-top">
        <span className="rail-label">开始</span>
        {props.onClose && (
          <button type="button" className="rail-close" onClick={props.onClose} title="收起侧边栏">
            ✕
          </button>
        )}
      </div>

      <div className="rail-scroll">
        {props.decisions && (
          <Section title="待决策" badge={props.decisionCount} defaultOpen>
            {props.decisions}
          </Section>
        )}
        {props.files && (
          <Section title="工作区文件" defaultOpen={false}>
            {props.files}
          </Section>
        )}
        {props.actions && (
          <Section title="快捷操作" defaultOpen>
            {props.actions}
          </Section>
        )}
      </div>
    </aside>
  );
}
