/**
 * 两族"形状特殊、但确实需要"的控件。
 *
 * 迁到这里之前，它们是散在 20 多个文件里的裸 `<button className="xxx">`。
 * 把它们收进来的目的不是让它们长得一样，而是：
 *
 * 1. **有名字**——搜索到 `OptionItem` 就知道这是"可选项的一行"，
 *    而不是某个页面私有的 `.model-item`；
 * 2. **共享行为**——默认 `type="button"`、`aria-selected` 跟着
 *    `selected` 走、键盘焦点环统一；
 * 3. **可测试**——`uiContract.test.ts` 认得它们，新代码再写裸 `<button>`
 *    就会红。
 *
 * 视觉仍由场景类决定（`model-item` `template-card` `main-tab-label`…），
 * 所以这一轮**一个像素都不变**。
 *
 * 但骨架类 `.option-item` 会一起挂上——它是"这个按钮有出处"的坐标，
 * 结构体检和 `uiContract.test.ts` 靠它区分"控件层管理的"与"裸写的"。
 * 骨架本身**刻意不设任何样式**：场景类已经定义了它们全部的外观，
 * 这里再加高度/内边距会改变现有视觉。它只做标记。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * 可选项：单选组、页签、列表里的可选中项。
 *
 * 与 `ListItem` 的区别：`OptionItem` **一定要有选中态**（它表达"选中了哪一项"），
 * 并自动带上 `aria-selected`。`ListItem` 只是"能点的一行"。
 */
export interface OptionItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  /** 是否选中。会同步到 `aria-selected`。 */
  readonly selected?: boolean;
  /** 场景类（`model-item` / `template-card` / `settings-nav-item` …）。 */
  readonly variant?: string;
  /** 额外的状态类（`active` / `focused` / `disabled`…）。 */
  readonly extraClass?: string;
  readonly children: ReactNode;
}

export const OptionItem = forwardRef<HTMLButtonElement, OptionItemProps>(
  function OptionItem(props, ref) {
    const { selected, variant, extraClass, children, ...rest } = props;
    // 骨架类 `option-item` 必须带上：它是"这个按钮已经被控件层接管"的标记。
    // 只挂场景类（settings-nav-item / template-card …）会让这些按钮
    // 在结构体检里看起来和裸 <button> 没有区别，等于没有出处。
    const cls = ['option-item', variant, selected ? 'active' : '', extraClass ?? '']
      .filter(Boolean)
      .join(' ');
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        aria-selected={selected ?? undefined}
        className={cls}
      >
        {children}
      </button>
    );
  },
);

/**
 * 发送按钮：输入框右下角那个**正圆**。
 *
 * ## 为什么它是一个独立组件而不是 Button 的一个 size
 *
 * 历史注释里写着原因（`Conversation.tsx` 原文）：
 *
 * > **不套 btn 系统**：通用按钮是胶囊/矩形语义，
 * > 套上去会得到 40×26 的椭圆。`.send-btn` 自己保证宽高相等 → 正圆。
 *
 * 也就是说它的形状是**刻意的差异**，不是漏网的不一致。
 * 但它同样需要一个统一的出处：全站有 3 处发送按钮
 * （`Conversation` / `NewSession` / `GlobalAssistant`），
 * 以前各写了一遍 `<button className="send-btn">`，
 * `disabled` 与 `aria-label` 是否齐全全凭运气。
 *
 * 这里把"必须有的东西"固定下来：`aria-label` 必填、`type="button"`、
 * 图标居中、禁用态统一。
 */
export interface SendButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'aria-label'> {
  /** 必填：发送按钮图标只有图形，读屏用户需要名字。 */
  readonly label?: string;
  readonly children: ReactNode;
}

export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(
  function SendButton(props, ref) {
    const { label = '发送', children, ...rest } = props;
    return (
      <button
        ref={ref}
        {...rest}
        type="button"
        aria-label={label}
        title={rest.title ?? label}
        className="send-btn"
      >
        {children}
      </button>
    );
  },
);
