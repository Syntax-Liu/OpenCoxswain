/**
 * Button —— 全站唯一的按钮。
 *
 * ## 为什么要这一层
 *
 * 用户的原话：
 * > 每次我让加新界面，要么直接用系统默认的按钮设计，
 * > 要么加一堆风格不一致的。
 *
 * 根因不是 CSS 写得不好（`.btn` 契约在 `styles.css` 里写得很清楚），
 * 而是**写新界面的人手里没有按钮可拿**——只能写 `<button>`，
 * 于是拿到浏览器默认样式，或者现场再糊一个 `.xxx-btn`。
 *
 * 这次把契约做成**组件**：TS 层直接不给你选错的机会。
 *
 * ## 对外只暴露 3 个变体
 *
 * | 变体 | 用在哪 |
 * | --- | --- |
 * | `primary` | 一屏只有一个：保存 / 确认 / 发送 |
 * | `secondary` | 有边框的次要动作：取消 / 关闭 / 返回 |
 * | `ghost` | 无边框的弱动作：展开 / 收起 / 更多 |
 *
 * `danger`（删除）与 `link`（文字按钮）**不在公开面里**——
 * 它们改成显式的 `DangerButton` / `TextButton`，
 * 想用就得写下这个名字，拦住"随手一个红按钮"。
 *
 * > 为什么不是 5 个变体一起暴露：用户抱怨的是**风格不一致**，不是**不够用**。
 * > 公开面越窄，界面越统一。
 *
 * ## 视觉零变化
 *
 * 内部渲染的还是原来的 `.btn .btn--<变体> .btn--<尺寸>`，
 * CSS 一行没改。所以整个迁移过程不改变任何像素。
 */
import { forwardRef, type ButtonHTMLAttributes, type ForwardedRef, type ReactNode } from 'react';

/** 公开的变体：只有 3 个。 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

/** 尺寸：3 档，与 CSS 的 `--h-sm/md/lg` 对齐。 */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** 撑满父级宽度。 */
  readonly wide?: boolean;
  /** 胶囊形态（欢迎页示例按钮这类）。 */
  readonly pill?: boolean;
  /**
   * 纯图标：样式等同 `.btn--icon`，且**必须**给 `aria-label`。
   * 没给会在开发时报错——一个没有名字的按钮对键盘和读屏用户等于不存在。
   */
  readonly iconOnly?: boolean;
  /**
   * **加载态**。
   *
   * 只加转圈、**不移除文字**——按钮突然变成空白或变成"…"，
   * 用户会以为自己点丢了。文字保留，右边多个圈就够了。
   *
   * 加载期间自动禁用（`disabled` + `pointer-events: none`），
   * 避免重复提交。
   */
  readonly loading?: boolean;
  /**
   * **附加上下文类**，例如 `active` / `rail-toggle` / `view-tab`。
   *
   * 只允许"给元素打标记"的类（状态、业务容器）。**不允许**再写 `btn--*`：
   * 契约只能由组件的 props 决定，否则又回到"各处各写各的"。
   */
  readonly className?: string;
  readonly children?: ReactNode;
}

/** `danger` / `link` 只允许内部组件使用。 */
type InternalVariant = ButtonVariant | 'danger' | 'link';

/**
 * 把 props 拼成 `.btn` 类串。
 *
 * 独立导出：所有按钮组件（含 IconButton / DangerButton / TextButton）共用这一处，
 * 免得几处各拼一遍、以后又漂开。测试也直接引用它。
 */
export function buttonClassName(options: {
  variant: InternalVariant;
  size: ButtonSize;
  wide?: boolean;
  pill?: boolean;
  iconOnly?: boolean;
  extra?: string;
}): string {
  const parts = ['btn', `btn--${options.variant}`, `btn--${options.size}`];
  if (options.wide) parts.push('wide');
  if (options.pill) parts.push('btn--pill');
  if (options.iconOnly) parts.push('btn--icon');
  if (options.extra) parts.push(options.extra);
  if (/btn--/.test(options.extra ?? '')) {
    // 契约类只能从 props 来。放进 className 就等于绕过了组件。
    throw new Error(
      `Button: className 里不许出现 btn-- 类（收到 "${options.extra}"）。` +
        '变体与尺寸请用 variant / size / wide / pill / iconOnly 属性。',
    );
  }
  return parts.join(' ');
}

function assertAccessibleName(props: ButtonProps): void {
  if (!props.iconOnly) return;
  if (props['aria-label'] || props.title) return;
  throw new Error(
    'Button: iconOnly 按钮必须给 aria-label（键盘和读屏用户靠它识别这个按钮）',
  );
}

/** 内部渲染器：变体由调用方写死，公开面不暴露这个入口。 */
function renderButton(
  variant: InternalVariant,
  props: ButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
): JSX.Element {
  assertAccessibleName(props);
  const { size = 'md', wide, pill, iconOnly, loading, className, children, ...rest } = props;
  return (
    <button
      ref={ref}
      {...rest}
      type="button"
      className={buttonClassName({ variant, size, wide, pill, iconOnly, extra: className })}
      // 屏幕阅读器要知道它在忙，光有转圈不够
      {...(loading ? { 'data-loading': 'true', 'aria-busy': 'true', disabled: true } : {})}
    >
      {children}
    </button>
  );
}

/**
 * 通用按钮。
 *
 * `variant` 省略时按 `primary`——保证"现在就要个按钮"这种场景下，
 * 拿到的是**看起来像主按钮**的东西，而不是浏览器默认样式。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    return renderButton(props.variant ?? 'primary', props, ref);
  },
);

/**
 * 破坏性动作（删除、清空、拒绝）。
 *
 * 单独一个组件而不是 `variant="danger"`：这个名字出现在代码里，
 * 就等于在说"这里真的会毁东西"，评审时一眼能看到。
 */
export const DangerButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function DangerButton(props, ref) {
    return renderButton('danger', props, ref);
  },
);

/**
 * 文字按钮（无边框、无内边距、看起来像链接）。
 *
 * 用于"展开更多""查看全部"这类不该占视觉重量的动作。
 */
export const TextButton = forwardRef<HTMLButtonElement, ButtonProps>(
  function TextButton(props, ref) {
    return renderButton('link', props, ref);
  },
);
