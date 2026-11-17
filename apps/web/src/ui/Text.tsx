/**
 * Text —— 给「内容长度不可控」的文本一个安全的容器。
 *
 * ## 这解决的是用户说的「文字溢出」
 *
 * 截断要四条同时成立，缺一不可（`overflowLayout.test.ts` 的注释里已写明）：
 *
 * ```
 * white-space: nowrap      否则它换行了，没有省略号
 * overflow: hidden         否则 ellipsis 不生效
 * text-overflow: ellipsis  省略号本身
 * min-width: 0             否则 flex 子项不收缩，根本不进这一步
 * ```
 *
 * 问题是**这四条以前只对 2 个元素有过测试**（模型列表项），
 * 所以"哪里会溢出"全靠碰运气发现。
 *
 * 用法上只有一句：**一行放不下时，用 `truncate`**。
 *
 * ```tsx
 * <Text truncate title={project.name}>{project.name}</Text>
 * ```
 *
 * `title` 建议跟着给——被截掉的那半截，用户还得能看见。
 */
import type { ElementType, HTMLAttributes, ReactNode } from 'react';

export interface TextProps extends Omit<HTMLAttributes<HTMLElement>, 'className'> {
  /**
   * 单行截断。
   *
   * 打开后会渲染 `.text-truncate`，它同时带齐四条声明。
   * **容器本身也要能收缩**——如果父级是 flex 且没写 `min-width: 0`，
   * 这里写得再对也不会截断。父级那侧在 CSS 里用 `.text-container`。
   */
  readonly truncate?: boolean;
  /** 渲染成什么标签。默认 `span`。 */
  readonly as?: ElementType;
  /**
   * 压暗的一档：元信息、次要说明。
   * 不叫 `muted` 是为了避免和 CSS 的 `.muted` 类混成一个概念——
   * 那个类历史上被到处加，已经看不出层级了。
   */
  readonly dim?: boolean;
  readonly children?: ReactNode;
}

export function Text(props: TextProps): JSX.Element {
  const { truncate, as, dim, children, ...rest } = props;
  const Tag = (as ?? 'span') as ElementType;
  const cls = [truncate ? 'text-truncate' : '', dim ? 'text-dim' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <Tag {...rest} className={cls || undefined}>
      {children}
    </Tag>
  );
}
