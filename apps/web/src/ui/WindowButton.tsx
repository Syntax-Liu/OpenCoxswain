/**
 * WindowButton —— 标题栏的最小化 / 最大化 / 关闭。
 *
 * ## 为什么单独一个组件，而不是用 IconButton
 *
 * 系统窗口按钮**不是**产品界面的一部分，它模仿的是操作系统：
 *
 * | | IconButton | WindowButton |
 * | --- | --- | --- |
 * | 尺寸 | 26 / 32 方 | 46×30 宽矩形 |
 * | 圆角 | `--r-sm` | **0**（贴边） |
 * | 光标 | `pointer` | `default`（Windows 原生行为） |
 * | 悬停 | 我们的悬停色 | 系统悬停色、关闭键悬停变红 |
 * | 间距 | 有 gap | **无 gap**，紧贴成一个按钮组 |
 *
 * 把它塞进 IconButton 会破坏这些，用户一眼就看出"窗口按钮不对劲"。
 * 这跟发送按钮的道理一样：**刻意的差异要有名字，而不是漏网。**
 *
 * 收进 `ui/` 的真实收益：
 * 1. `title` 与 `aria-label` 必填——三个按钮都是纯图形；
 * 2. 关闭键的 `close` 变体只有一个出口，不会有人忘写红色悬停；
 * 3. `uiContract.test.ts` 认得它，标题栏里不再有孤儿 `<button>`。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface WindowButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'aria-label'> {
  /** 必填：这个按钮做什么。同时用于 title 与 aria-label。 */
  readonly label: string;
  /** 关闭键：悬停变红。 */
  readonly close?: boolean;
  readonly children: ReactNode;
}

export const WindowButton = forwardRef<HTMLButtonElement, WindowButtonProps>(
  function WindowButton(props, ref) {
    const { label, close, children, ...rest } = props;
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        aria-label={label}
        title={rest.title ?? label}
        className={close ? 'win-btn win-close' : 'win-btn'}
      >
        {children}
      </button>
    );
  },
);
