/**
 * 界面字号缩放。
 *
 * ## 为什么要做
 *
 * 用户反馈"字体有点小了"，并且希望能自己调。
 *
 * 这不是加一个开关就行——字号在界面里是 `--fs-*` 变量，
 * 缩放系数必须作用在这 4 个变量上，**所有控件才会一起变**。
 * 如果只改某几处的 font-size，就会重新变成"尺度不一"（刚清理完的问题）。
 *
 * ## 做法
 *
 * 基准是"标准"档（11/12/13/15），其余档位是基准乘以一个系数：
 *
 *     小     0.94
 *     标准   1.00
 *     大     1.08   ← 默认（实测标准档在 2K 屏上偏小）
 *     更大   1.16
 *
 * 比例关系保持不变，所以"层级感"在任何档位下都一样。
 */

export type FontScale = 'small' | 'standard' | 'large' | 'xlarge';

export interface FontScaleOption {
  readonly id: FontScale;
  readonly label: string;
  /** 相对"标准"的倍数。 */
  readonly factor: number;
}

export const FONT_SCALE_OPTIONS: readonly FontScaleOption[] = [
  { id: 'small', label: '小', factor: 0.94 },
  { id: 'standard', label: '标准', factor: 1 },
  { id: 'large', label: '大', factor: 1.08 },
  { id: 'xlarge', label: '更大', factor: 1.16 },
];

/** 默认档：实测"标准"在 2K 屏上偏小，默认给"大"。 */
export const DEFAULT_FONT_SCALE: FontScale = 'large';

/** 存本地时用的键。 */
export const FONT_SCALE_STORAGE_KEY = 'opencoxswain:font-scale';

/** 把档位换算成 CSS 变量值。 */
export function fontScaleFactor(scale: FontScale): number {
  return FONT_SCALE_OPTIONS.find((o) => o.id === scale)?.factor ?? 1;
}

/** 解析从 localStorage 读出来的值，非法值退回默认。 */
export function parseFontScale(raw: string | null | undefined): FontScale {
  if (!raw) return DEFAULT_FONT_SCALE;
  return FONT_SCALE_OPTIONS.some((o) => o.id === raw)
    ? (raw as FontScale)
    : DEFAULT_FONT_SCALE;
}

/**
 * 把缩放应用到文档根元素。
 *
 * 只改 `--font-scale` 一个变量——4 档字号都是用 calc 基于它算的，
 * 所以整个界面会等比缩放，不会出现某处没变的情况。
 */
export function applyFontScale(scale: FontScale, root?: HTMLElement): void {
  const target = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return;
  target.style.setProperty('--font-scale', String(fontScaleFactor(scale)));
}
