/**
 * 状态栏指标：**每个数字都要有标签和口径**。
 *
 * ## 问题
 *
 * 用户和第三方分析都指出：状态栏一排数字互相打架、没有单位、没有口径。
 *
 *     225 轮 · 319 步    ← 一轮是什么？
 *     173 tok/s          ← 哪个模型？瞬时还是平均？
 *     2.196M tok         ← 累计还是当前会话？
 *     缓存命中 91%        ← 这算什么指标，我能做什么？
 *     39%                ← 最谜的一个，连标签都没有
 *
 * ## 原则
 *
 * 1. **每个数字必须有可见的短标签**——不能只有一个图标
 * 2. **口径写进 tooltip**——想深究的人能看到怎么算的
 * 3. **分三组**：工作量 / 性能 / 上下文。混在一起读不出任何结论
 * 4. **调试类指标降级**——`缓存命中` 是给我们排查用的，
 *    用户看它没有任何可行动的信息，放进详情里而不是常驻
 */

export interface StatusMetric {
  /** 稳定的 id，用于测试和 key。 */
  readonly id: string;
  /** 显示的短标签。**不能为空**——只有一个图标等于没标签。 */
  readonly label: string;
  /** 显示的数值（已格式化）。 */
  readonly value: string;
  /** 口径说明，挂在 tooltip 上。 */
  readonly detail: string;
}

export interface StatusGroup {
  readonly id: 'work' | 'perf' | 'context';
  readonly metrics: readonly StatusMetric[];
}

export interface StatusInput {
  readonly turns?: number;
  readonly steps?: number;
  readonly tokensPerSecond?: string;
  readonly totalTokens?: string;
  readonly cacheHit?: string;
  /** 上下文用量 0–1。 */
  readonly contextRatio: number;
  readonly contextUsed: string;
  readonly contextLimit: string;
  /** 是否显示调试类指标（缓存命中）。 */
  readonly showDebug?: boolean;
}

/** 把数字压成紧凑写法：1234 → 1.2k，1960000 → 1.96M。 */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

/**
 * 组装状态栏。
 *
 * 顺序有意义：**工作量 → 性能 → 上下文**。
 * 用户最常关心"跑了多少"，其次"快不快"，最后"还剩多少空间"。
 */
export function buildStatus(input: StatusInput): StatusGroup[] {
  const turns = input.turns ?? 0;
  const steps = input.steps ?? 0;

  const work: StatusGroup = {
    id: 'work',
    metrics: [
      {
        id: 'turns',
        label: '轮次',
        value: String(turns),
        detail: `模型被调用了 ${turns} 次。一次"轮"= 一次完整的模型往返`,
      },
      {
        id: 'steps',
        label: '步数',
        value: String(steps),
        detail: `工具被执行了 ${steps} 次。步数通常多于轮次——一轮里可能连着调几个工具`,
      },
    ],
  };

  const perf: StatusMetric[] = [
    {
      id: 'tokens',
      label: '累计',
      value: input.totalTokens ?? '—',
      detail: '本次会话累计消耗的 token（输入 + 输出）。不是钱，只是量',
    },
  ];
  // 速度只在有值时才显示——这个会话还没跑完时没有意义
  if (input.tokensPerSecond && input.tokensPerSecond !== '—') {
    perf.unshift({
      id: 'speed',
      label: '速度',
      value: `${input.tokensPerSecond} tok/s`,
      detail: '本次会话的输出速度（只算模型调用时间，不含本地工具等待）',
    });
  }
  // **缓存命中默认不显示**：它是给我们排查成本的，用户看了无法行动
  if (input.showDebug && input.cacheHit && input.cacheHit !== '—') {
    perf.push({
      id: 'cache',
      label: '缓存',
      value: input.cacheHit,
      detail:
        '命中提示缓存的输入比例。命中越高越省，但这是成本细节，不影响你做什么',
    });
  }

  const percent = Math.round(input.contextRatio * 100);
  const context: StatusGroup = {
    id: 'context',
    metrics: [
      {
        id: 'context',
        label: '上下文',
        value: `${percent}%`,
        detail: `当前会话已用 ${input.contextUsed} / ${input.contextLimit}。接近上限时较早的内容会被自动折叠`,
      },
    ],
  };

  return [work, { id: 'perf', metrics: perf }, context];
}

/** 一行文本形式（供 tooltip 或无障碍朗读）。 */
export function summarizeStatus(groups: readonly StatusGroup[]): string {
  return groups
    .flatMap((g) => g.metrics.map((m) => `${m.label} ${m.value}`))
    .join(' · ');
}
