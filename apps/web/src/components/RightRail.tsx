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

import { IconClose, IconFolder, IconGlobe, IconPlus, IconSettings } from './icons.js';
import { IconButton, ListItem, OptionItem } from '../ui/index.js';

export interface RightRailProps {
  /** 应用图标配色（用户选的）。不传就用紫罗兰。 */
  readonly iconTheme?: string;

  /** 待决策面板（传 null 表示没有）。 */
  readonly decisions?: ReactNode;
  /** 改动视图：最近几轮 Agent 改了什么，点进去看 Diff。 */
  readonly changes?: ReactNode;
  /** 工作区文件区。 */
  readonly files?: ReactNode;
  /** 没有任何内容时显示的东西（照 DSH 的四张功能卡片）。 */
  readonly emptyState?: ReactNode;
  /** 改动条数，显示在页签上。 */
  readonly changeCount?: number;
  /**
   * 当前页签（受控）。
   *
   * 外部要能切页签——比如「工作区文件」卡片点了要跳到「文件」页。
   * 不传就是非受控，组件自己管。
   */
  readonly activeTab?: string;
  readonly onTabChange?: (id: string) => void;
  /** 关闭右栏。 */
  readonly onClose?: () => void;
  /** 决策条数，显示在标题上。 */
  readonly decisionCount?: number;
}

/**
 * 右栏：**横向多标签页**（2026-11-16 用户要求，照 DSH）。
 *
 * ## 为什么从纵向分区改过来
 *
 * 原来三块（待决策 / 工作区文件 / 快捷操作）纵向堆在一起，每块可折叠。
 * 问题是它们**互相抢垂直空间**：待决策展开就看不见文件，
 * 而且用户得一路滚下去才知道下面还有东西。
 *
 * 用户的原话：
 *
 * > 既然做了，那就像 DSH 这样吧，侧边栏可以放多个页面
 *
 * 改成标签后每块独占整个右栏高度，切过去就是完整内容。
 */
export function RightRail(props: RightRailProps): JSX.Element {
  // 有哪些页签：只有传了内容的才出。
  const tabs = [
    { id: 'start' as const, title: '开始', node: props.emptyState, badge: 0 },
    {
      id: 'decisions' as const,
      title: '待决策',
      node: props.decisions,
      badge: props.decisionCount ?? 0,
    },
    { id: 'changes' as const, title: '改动', node: props.changes, badge: props.changeCount ?? 0 },
    { id: 'files' as const, title: '文件', node: props.files, badge: 0 },
  ].filter((t) => t.node);

  const [selfActive, setSelfActive] = useState<string>(tabs[0]?.id ?? 'start');
  const active = props.activeTab ?? selfActive;
  const setActive = (id: string): void => {
    if (props.onTabChange) props.onTabChange(id);
    else setSelfActive(id);
  };

  // 当前页签没内容时（比如待决策被清空），退回第一个可用的。
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <aside className="rail" aria-label="侧边栏">
      <div className="rail-top">
        <span className="rail-label">开始</span>
        {props.onClose && (
          <IconButton onClick={props.onClose} title="收起侧边栏" label={"收起侧边栏"}><IconClose size={14} /></IconButton>
        )}
      </div>

      {/* 页签条：内容多时自己横向滚，不压缩标签文字 */}
      <div className="rail-tabs" role="tablist">
        {tabs.map((t) => (
          <OptionItem
            key={t.id}
            role="tab"
            selected={current?.id === t.id}
            variant="rail-tab"
            onClick={() => setActive(t.id)}
          >
            {t.title}
            {t.badge > 0 && <span className="rail-badge">{t.badge}</span>}
          </OptionItem>
        ))}
      </div>

      <div className="rail-scroll" role="tabpanel">
        {current?.node}
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
      // 这里是「在浏览器中打开」，用通用图标；
      // 品牌图标（AppIcon）只用在"代表这个应用"的位置，
      // 用在一个功能入口上会让人误以为是应用菜单。
      icon: <IconGlobe size={16} />,
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
        <ListItem key={card.key} variant="rail-empty-card" onClick={card.onClick}>
          <span className="rail-empty-icon">{card.icon}</span>
          <span className="rail-empty-body">
            <span className="rail-empty-title">{card.title}</span>
            <span className="rail-empty-hint">{card.hint}</span>
          </span>
        </ListItem>
      ))}
    </div>
  );
}
