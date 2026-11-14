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

/**
 * Supervisor：**统筹调度**。
 *
 * 之前是"圆 + 四向短射线"，看起来像靶心/准星，
 * 和旁边圆角矩形的图标风格不搭（用户反馈"重新设计，符合统一标准"）。
 *
 * 改成：中心一个节点，三条线连到外围三个节点——
 * 表达"一个协调者调度多个执行者"，正是 Supervisor 的职责。
 * 全部用圆 + 直线，和图标库其它图标同一套笔触。
 */
export function IconSupervisor({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)}>
      {/* **整体下移 1.62**：实测这一组图形的绘制中线在 y=6.38，
          比视口中心 8 高 1.62px，视觉上就是"图标偏上"。
          所以这里所有 y 坐标统一 +1.62，让绘制范围居中。 */}
      {/* 中心节点 */}
      <circle cx="8" cy="9.62" r="2" />
      {/* 三条连线 */}
      <path d="M8 7.62 8 5.12M6.3 8.52 4.2 11.12M9.7 8.52l2.1 2.6" />
      {/* 三个外围节点 */}
      <circle cx="8" cy="3.87" r="1.25" />
      <circle cx="3.25" cy="12.12" r="1.25" />
      <circle cx="12.75" cy="12.12" r="1.25" />
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
      {/* **整体上移 1.25**：实测绘制中线在 y=9.25，比视口中心低 1.25px。 */}
      <path d="M2 2.25h8.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6L3.5 11.75v-2.5H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
      <path d="M12.5 4.25h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-.5v2.5L10.5 11.25H9" />
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
      {/* **下移 0.75**：实测绘制中线在 y=7.25，略偏高。 */}
      <path d="M8 2.75v7.5M4.75 7.25 8 10.5l3.25-3.25M2.5 13.25h11" />
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

/** 品牌标记：舵手（一个简化的舵轮）。 */
export function IconBrand({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size, className)} strokeWidth={1.4}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.75" />
      <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3" />
    </svg>
  );
}
