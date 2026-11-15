/**
 * 设计令牌（新界面）。
 *
 * 结构沿用旧界面的三层分层——那套是对的，被 698 条测试验证过：
 *   原始层 --ink-* / --signal-*   ：只有这里写色值
 *   语义层 --surface-* / --text-* ：含义 → 原始层
 *   组件层                        ：只引用语义层
 *
 * 与旧界面的区别在**取值与含义**：
 *   - 中性色更冷、暗端更深（画布 #0c0f14）；
 *   - 信号色只有三个，且 cyan 只表示"正在跑"；
 *   - 圆角更大（6/10/14），但深度仍靠边框而非阴影。
 */

export const tokens = {
  /** 原始层：中性（石墨，偏冷）。 */
  ink: {
    900: '#0c0f14', // 画布
    850: '#0e1319', // 画布与面板之间
    800: '#12161d', // 面板
    750: '#161b24', // 抬起
    700: '#1a1f28', // 悬停
    650: '#212734', // 选中
    600: '#2a313d', // 边框 / 分隔
    500: '#3d4553', // 强边框
    400: '#5c6678', // 禁用文字
    300: '#8b95a5', // 次要文字
    200: '#b8c0cc', // 强次要文字
    100: '#e6eaf0', // 正文
  },

  /** 原始层：信号色。三者互不代用。 */
  signal: {
    run: '#00c2a8', // 正在跑（唯一）
    ask: '#f0a020', // 要你拍板（唯一）
    stop: '#e5484d', // 失败 / 危险（唯一）
    done: '#4a9d6f', // 完成
  },
} as const;

/**
 * 语义层映射说明（供文档与测试引用）：
 *
 *   表面：canvas → panel → raised → hover → selected（越靠用户越浅）
 *   文字：primary(正文) → secondary(次要) → tertiary(元信息) → disabled
 *   状态：running=signal.run / asking=signal.ask / failed=signal.stop / done=signal.done
 */
export const SEMANTIC = {
  surfaceCanvas: 'ink.900',
  surfacePanel: 'ink.800',
  surfaceRaised: 'ink.750',
  surfaceHover: 'ink.700',
  surfaceSelected: 'ink.650',
  borderSubtle: 'ink.600',
  borderStrong: 'ink.500',
  textPrimary: 'ink.100',
  textSecondary: 'ink.300',
  textTertiary: 'ink.400',
  running: 'signal.run',
  asking: 'signal.ask',
  failed: 'signal.stop',
  done: 'signal.done',
} as const;

/** 间距（4px 基准）。 */
export const space = {
  0: '2px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '24px',
  6: '32px',
  7: '48px',
} as const;

/** 圆角。 */
export const radius = {
  sm: '6px',
  md: '10px',
  lg: '14px',
  full: '999px',
} as const;

/** 字号与行高。正文 15/1.65——比旧界面松，解决"太挤"。 */
export const type = {
  xs: { size: '12px', line: '1.5' },
  sm: { size: '13px', line: '1.55' },
  md: { size: '15px', line: '1.65' },
  lg: { size: '17px', line: '1.5' },
  xl: { size: '21px', line: '1.35' },
} as const;

/** 动效。 */
export const motion = {
  fast: '120ms',
  base: '200ms',
  ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;
