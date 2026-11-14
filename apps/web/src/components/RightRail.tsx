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

import { IconBrand, IconChevron, IconClose, IconFolder, IconPlus, IconSettings } from './icons.js';

export interface RightRailProps {
  /** 待决策面板（传 null 表示没有）。 */
  readonly decisions?: ReactNode;
  /** 工作区文件区。 */
  readonly files?: ReactNode;
  /** 快捷操作区。 */
  readonly actions?: ReactNode;
  /** 没有任何内容时显示的东西（照 DSH 的四张功能卡片）。 */
  readonly emptyState?: ReactNode;
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
        <span className="rail-caret">
          <IconChevron size={12} direction={open ? 'down' : 'right'} />
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
            <IconClose size={14} />
          </button>
        )}
      </div>

      <div className="rail-scroll">
        {/* **没有内容时显示功能卡片**（照 DSH）：
            之前是留一片空白，用户以为坏了。 */}
        {!props.decisions && !props.files && !props.actions && props.emptyState}
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


/**
 * 右栏空状态：四张功能卡片（照 DSH）。
 *
 * 只在"没有任何可显示的内容"时出现——比如新会话页、
 * Supervisor 页、或者对话里暂时没有待决策事项。
 */
export function RailEmptyState(props: {
  /** 打开工作区文件面板。 */
  readonly onOpenFiles?: () => void;
  /** 在系统文件管理器里打开项目目录。 */
  readonly onOpenFolder?: () => void;
  /** 在外部浏览器打开（有 URL 时才有意义）。 */
  readonly onOpenBrowser?: () => void;
  /** 打开设置。 */
  readonly onOpenSettings?: () => void;
}): JSX.Element {
  const cards = [
    props.onOpenFiles && {
      key: 'files',
      icon: <IconFolder size={16} />,
      title: '工作区文件',
      hint: '浏览会话工作区的文件',
      onClick: props.onOpenFiles,
    },
    props.onOpenFolder && {
      key: 'terminal',
      icon: <IconPlus size={16} />,
      title: '打开项目目录',
      hint: '在资源管理器里查看这个项目',
      onClick: props.onOpenFolder,
    },
    props.onOpenBrowser && {
      key: 'browser',
      icon: <IconBrand size={16} />,
      title: '在浏览器中打开',
      hint: '用系统默认浏览器打开',
      onClick: props.onOpenBrowser,
    },
    props.onOpenSettings && {
      key: 'more',
      icon: <IconSettings size={16} />,
      title: '更多工具',
      hint: '设置、模型、权限',
      onClick: props.onOpenSettings,
    },
  ].filter(Boolean) as Array<{
    key: string;
    icon: JSX.Element;
    title: string;
    hint: string;
    onClick: () => void;
  }>;

  if (cards.length === 0) return <p className="rail-empty-text">这里暂时没有内容。</p>;

  return (
    <div className="rail-empty">
      {cards.map((card) => (
        <button key={card.key} type="button" className="rail-empty-card" onClick={card.onClick}>
          <span className="rail-empty-icon">{card.icon}</span>
          <span className="rail-empty-body">
            <span className="rail-empty-title">{card.title}</span>
            <span className="rail-empty-hint">{card.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
