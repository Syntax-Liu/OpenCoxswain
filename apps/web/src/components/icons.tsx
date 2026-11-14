/**
 * 图标：**全部用 SVG，不用字符**。
 *
 * ## 为什么换掉字符图标
 *
 * 之前用 `⊕ ◎ ⊞ ▾ ◫` 这些 Unicode 字符当图标。问题：
 *
 * 1. **字体依赖**——在不同机器/字体下粗细、大小、基线都不一样，
 *    同一排的几个图标对不齐
 * 2. **基线偏移**——字符有行高和基线，放进按钮里要反复调 padding 才能居中
 * 3. **无法控制笔画粗细**——DSH 那种统一的 1.5px 线性图标做不到
 *
 * 实测用户反馈：「新会话的+号，Supervisor的符号，添加项目的＋号，
 * 侧边栏打开的符号，都很丑」——四个都是字符。
 *
 * ## 规格（照 DSH）
 *
 * - 尺寸 16×16（侧栏），14×14（紧凑处）
 * - 线性，`stroke-width: 1.5`
 * - 线帽圆、连接圆
 * - 颜色继承 `currentColor`，由外层控制
 */

export interface IconProps {
  /** 尺寸，默认 16。 */
  readonly size?: number;
  readonly className?: string;
}

/** 所有图标的公共属性。 */
function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className,
  };
}

/** 新会话：圆圈里一个加号。 */
export function IconNewChat({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </svg>
  );
}

/** Supervisor：指挥台的"领航"符号——一个圆 + 四个方向的短射线。 */
export function IconSupervisor({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="8" r="3.25" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5" />
    </svg>
  );
}

/** 添加项目：文件夹 + 加号。 */
export function IconAddProject({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.25 1.5h5.25a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
      <path d="M8 7.5v3M6.5 9h3" />
    </svg>
  );
}

/** 侧边栏开关：一个带左分栏的方框。 */
export function IconSidebar({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
      <path d="M6.25 3v10" />
    </svg>
  );
}

/** 折叠箭头：展开是右，收起是下。 */
export function IconChevron({ size = 16, className, direction = 'right' }: IconProps & { direction?: 'right' | 'down' }): JSX.Element {
  return (
    <svg {...base(size, className)}>
      {direction === 'right' ? <path d="M6 3.5 10.5 8 6 12.5" /> : <path d="M3.5 6 8 10.5 12.5 6" />}
    </svg>
  );
}

/** 文件夹（项目）。 */
export function IconFolder({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.25 1.5h5.25a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** 关闭：叉。 */
export function IconClose({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
