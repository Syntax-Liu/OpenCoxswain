/**
 * IconButton —— 纯图标按钮。
 *
 * ## 为什么单独一个组件
 *
 * 界面里散落着 15+ 个**自己写的小图标按钮**：`rail-close` `main-tab-close`
 * `notice-card-close` `error-card-close` `attachment-remove` `search-clear`…
 * 每一个都自己定尺寸、悬停色、内边距。它们看起来差不多但不完全一样——
 * 这正是用户说的「加一堆风格不一致的」最具体的形态。
 *
 * 统一后只有两种尺寸：
 *
 * | 尺寸 | 高度 | 用在哪 |
 * | --- | --- | --- |
 * | `sm` | 26px | 行内小动作：关闭提示条、移除附件 |
 * | `md` | 32px | 区块级：关闭面板、折叠页签 |
 *
 * ## 强制可读名字
 *
 * `label` 是**必填**的，会渲染成 `aria-label` + `title`。
 * 纯图标按钮没有名字，读屏用户和悬停找功能的用户都会失去入口。
 * 把它做成必填参数，就没人会漏。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { buttonClassName, type ButtonSize } from './Button.js';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'aria-label'> {
  /** 必填：这个图标是干什么的。同时用于 aria-label 与 title。 */
  readonly label: string;
  /** 只支持两档：`sm`（行内）与 `md`（区块）。 */
  readonly size?: Extract<ButtonSize, 'sm' | 'md'>;
  /** 视觉变体：图标按钮几乎总是 `ghost`。 */
  readonly variant?: 'ghost' | 'secondary';
  /** 附加上下文类（`active` 这类）。不许写 `btn--*`。 */
  readonly className?: string;
  readonly children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const { label, size = 'sm', variant = 'ghost', className, children, ...rest } = props;
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        aria-label={label}
        title={rest.title ?? label}
        className={`${buttonClassName({ variant, size, iconOnly: true, extra: className })}${
          size === 'md' ? ' btn--icon-md' : ''
        }`}
      >
        {children}
      </button>
    );
  },
);
