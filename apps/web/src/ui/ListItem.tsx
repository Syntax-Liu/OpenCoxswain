/**
 * ListItem —— 列表行 / 导航项。
 *
 * ## 这一类为什么必须和 Button 分开
 *
 * 界面里有一大批"长得不像按钮的按钮"：侧栏的导航项、会话行、项目行、
 * 命令面板的结果项、文件树的节点、右键菜单项、页签。
 *
 * 它们和 Button 的区别不是审美，是**语义**：
 *
 * | | Button | ListItem |
 * | --- | --- | --- |
 * | 占位 | 有内边距的独立控件 | 撑满整行 |
 * | 对齐 | 居中 | 左对齐（图标 + 文字） |
 * | 高度 | 26 / 32 / 38 | 行高，通常 26–30 |
 * | 焦点 | 圆角描边 | 整行高亮 |
 * | 用途 | 触发动作 | 选择一项 |
 *
 * 以前这十几种都是各写各的（`nav-item` `thread-item` `route-item`
 * `changes-item` `change-file` `file-node` `palette-item` `ctx-item`…），
 * 于是行高、缩进、悬停色、选中态各不相同——用户说的
 * 「加一堆风格不一致的」，主要就出在这里。
 *
 * ## 统一做法
 *
 * 所有行共享 `.list-item` 的**骨架**（`display: flex` / 左对齐 / 整行点击区 /
 * 高度来自 `--h-*` / 悬停与选中来自语义令牌），
 * 各场景只通过 `density` 和 `selected` 表达差异。
 *
 * **旧的非 .btn 类（`nav-item` 等）暂时保留**：它们承载场景特有样式
 * （缩进层级、图标 20px、左侧强调条）。这一轮先把控件来源统一到组件，
 * 把重复声明的骨架收进 `.list-item`，视觉不变。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/** 行密度：决定行高与水平内边距。 */
export type ListItemDensity = 'compact' | 'normal' | 'roomy';

export interface ListItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {  /** 选中态：整行高亮 + 左侧强调条。 */
  readonly selected?: boolean;
  readonly density?: ListItemDensity;
  /**
   * 附带的**状态类**（`running` / `failed` / `done` 这类）。
   *
   * 状态类不是布局，是"这一行现在处于什么态"，由业务数据决定；
   * 直接拼在 `variant` 后面。
   */
  readonly extraStatus?: string;
  /**
   * 场景类（`nav-item` / `thread-item` / `file-node` …）。
   *
   * 保留它是为了这一轮**零视觉变更**：这些类里写着各场景的专属样式
   * （缩进、图标尺寸、强调条颜色）。以后逐步把公共部分收进 `.list-item`，
   * 再一个个删掉场景类。
   *
   * **不许**写 `btn--*`——那是 Button 的契约。
   */
  readonly variant?: string;
  readonly children: ReactNode;
}

const DENSITY_CLASS: Record<ListItemDensity, string> = {
  compact: 'list-item--compact',
  normal: '',
  roomy: 'list-item--roomy',
};

export function listItemClassName(options: {
  density?: ListItemDensity;
  selected?: boolean;
  variant?: string;
}): string {
  const parts = ['list-item'];
  const d = DENSITY_CLASS[options.density ?? 'normal'];
  if (d) parts.push(d);
  if (options.selected) parts.push('is-selected');
  if (options.variant) parts.push(options.variant);
  const joined = parts.join(' ');
  if (/btn--/.test(options.variant ?? '')) {
    throw new Error(
      `ListItem: variant 里不许出现 btn-- 类（收到 "${options.variant}"）。` +
        '要按钮请用 Button。',
    );
  }
  return joined;
}

/**
 * ListItem 一行可点击的列表项。
 *
 * **不是** Button 的子集：它撑满整行、左对齐、可以有多行内容，
 * 默认 `type="button"`，`aria-selected` 跟着 `selected` 走。
 */
export const ListItem = forwardRef<HTMLButtonElement, ListItemProps>(
  function ListItem(props, ref) {
    const { selected, density, variant, extraStatus, children, ...rest } = props;
    const base = listItemClassName({ density, selected, variant });
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        aria-selected={selected ?? undefined}
        className={extraStatus ? `${base} ${extraStatus}` : base}
      >
        {children}
      </button>
    );
  },
);


/**
 * 菜单项。
 *
 * 单独一族而不是复用 ListItem：它的样式由**父容器的后代选择器**决定
 * （`.ctx-menu button` / `.ctx-menu button:hover` / `.ctx-menu button.danger`），
 * 而 ListItem 自带 `.list-item` 骨架（高度、内边距、圆角）。
 * 两者叠在一起会打架——菜单项的 4px 内边距会被 ListItem 的高度覆盖。
 *
 * 所以这里**不加骨架类**，只负责"它是一个菜单项"这件事：
 * `type="button"`、`role="menuitem"`、可选的 `danger`。
 * 这样 `styles.css` 里那一组后代选择器一个字节都不用改，视觉零变化。
 */
export interface MenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'role'> {
  /** 破坏性菜单项（删除这类），渲染 `danger` 类。 */
  readonly danger?: boolean;
  readonly children: ReactNode;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  function MenuItem(props, ref) {
    const { danger, children, ...rest } = props;
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        role="menuitem"
        className={danger ? 'danger' : undefined}
      >
        {children}
      </button>
    );
  },
);
