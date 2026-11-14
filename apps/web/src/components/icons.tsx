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

/* ---------- 设置页图标 ---------- */

/** 模型：一个立方体（表示"模型"这种抽象结构）。 */
export function IconModel({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M8 1.75 14 5v6l-6 3.25L2 11V5z" />
      <path d="M2 5l6 3.25L14 5M8 8.25v6" />
    </svg>
  );
}

/** 权限审批：一面盾牌。 */
export function IconShield({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M8 1.75 13.5 4v4.5c0 3-2.3 5-5.5 5.75-3.2-.75-5.5-2.75-5.5-5.75V4z" />
      <path d="M5.75 8.25 7.25 9.75l3-3" />
    </svg>
  );
}

/** 对话与记忆：两个重叠的气泡。 */
export function IconMemory({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M2 3.5h8.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6L3.5 13v-2.5H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
      <path d="M12.5 5.5h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-.5V15L10.5 12.5H9" />
    </svg>
  );
}

/** 通用：滑块（表示"可调节的设置"）。 */
export function IconSettings({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M2 4.5h4M9 4.5h5M2 11.5h7M12 11.5h2" />
      <circle cx="7.5" cy="4.5" r="1.5" />
      <circle cx="10.5" cy="11.5" r="1.5" />
    </svg>
  );
}

/** 手机通道：手机。 */
export function IconPhone({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <rect x="4" y="1.75" width="8" height="12.5" rx="1.5" />
      <path d="M7 12h2" />
    </svg>
  );
}

/** 下载/更新：向下箭头 + 底托。 */
export function IconDownload({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M8 2v7.5M4.75 6.5 8 9.75l3.25-3.25M2.5 12.5h11" />
    </svg>
  );
}

/** 加号（附件）。 */
export function IconPlus({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** 发送：向上箭头。 */
export function IconSend({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />
    </svg>
  );
}
