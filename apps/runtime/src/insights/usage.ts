/**
 * 使用报告：让用户看清**自己是怎么用这个产品的**。
 *
 * ## 为什么需要
 *
 * `project-status.md` 里"最该做的一件事"写的是"真实使用反馈"。
 * 但要拿到反馈，先得**看得见自己怎么用的**——
 * 现在只有实时状态（在跑几个、待决策几个），没有历史。
 *
 * 用户装了一周之后想知道：
 * - 我派了多少任务？成功率多少？
 * - 哪类任务最常失败？
 * - 我是不是把同样的活派了好几遍？
 * - 是不是有项目建了就没碰过？
 *
 * ## 一个原则：只统计，不评价
 *
 * 报告只呈现事实，不做"你的效率如何"这种判断。
 * 用户自己会得出结论，产品不该替他下判断。
 *
 * ## 另一个原则：不收集、不上传
 *
 * 全部在本地算，从本地数据库读。**没有任何上报**。
 */

export interface UsageStats {
  /** 统计覆盖的天数。 */
  readonly days: number;
  /** 任务总数。 */
  readonly executors: { readonly total: number; readonly done: number; readonly failed: number; readonly cancelled: number };
  /** 成功率（done / 已结束），没有已结束的任务时为 null。 */
  readonly successRate: number | null;
  /** 最常用的工具（按调用次数）。 */
  readonly topTools: readonly { readonly name: string; readonly count: number }[];
  /** 失败最多的原因归类。 */
  readonly topFailures: readonly { readonly reason: string; readonly count: number }[];
  /** 长期没动的项目。 */
  readonly staleProjects: readonly { readonly name: string; readonly daysSince: number }[];
  /** 重复派活的迹象：同一写域被多个 Agent 写过。 */
  readonly repeatedTargets: readonly { readonly target: string; readonly count: number }[];
}

export interface UsageInput {
  readonly days: number;
  readonly executors: readonly {
    readonly status: string;
    readonly label: string;
    readonly createdAt: number;
    readonly blockedReason: string | null;
  }[];
  /** side_effect 表里的工具调用记录。 */
  readonly effects: readonly {
    readonly tool: string;
    readonly target: string;
    readonly state: string;
    readonly createdAt: number;
  }[];
  readonly projects: readonly { readonly name: string; readonly lastActivityAt: number }[];
  /** 当前时间，测试用。 */
  readonly now?: number;
}

/** 把失败原因归类成几个大类。 */
export function categorizeFailure(reason: string | null): string {
  if (!reason) return '未说明原因';
  const r = reason.toLowerCase();

  if (/enoent|not found|不存在|no such/.test(r)) return '文件/路径不存在';
  if (/eacces|eperm|permission|权限|拒绝/.test(r)) return '权限问题';
  if (/timeout|超时|timed out/.test(r)) return '超时';
  if (/用量上限|budget|token/.test(r)) return '达到用量上限';
  if (/拦截|沙箱|sandbox|blocked/.test(r)) return '被沙箱拦住';
  if (/未获批准|rejected|拒绝执行/.test(r)) return '审批未通过';
  if (/测试|test/.test(r)) return '测试失败';
  if (/卡点|需要用户/.test(r)) return '需要用户决定';
  return '其它';
}

/** 算使用报告。 */
export function buildUsageReport(input: UsageInput): UsageStats {
  const now = input.now ?? Date.now();
  const since = now - input.days * 86_400_000;

  const recent = input.executors.filter((e) => e.createdAt >= since);
  const done = recent.filter((e) => e.status === 'done').length;
  const failed = recent.filter((e) => e.status === 'failed').length;
  const cancelled = recent.filter((e) => e.status === 'cancelled').length;
  const finished = done + failed + cancelled;

  // 工具使用频次
  const toolCount = new Map<string, number>();
  for (const e of input.effects) {
    if (e.createdAt < since) continue;
    toolCount.set(e.tool, (toolCount.get(e.tool) ?? 0) + 1);
  }
  const topTools = [...toolCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // 失败归类
  const failCount = new Map<string, number>();
  for (const e of recent) {
    if (e.status !== 'failed' && e.status !== 'cancelled') continue;
    const cat = categorizeFailure(e.blockedReason);
    failCount.set(cat, (failCount.get(cat) ?? 0) + 1);
  }
  const topFailures = [...failCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // 长期没动的项目（7 天以上没活动）
  const staleProjects = input.projects
    .map((p) => ({ name: p.name, daysSince: Math.floor((now - p.lastActivityAt) / 86_400_000) }))
    .filter((p) => p.daysSince >= 7)
    .sort((a, b) => b.daysSince - a.daysSince);

  // 重复写同一个目标——可能是在反复改同一个文件
  const targetCount = new Map<string, number>();
  const countedByTarget = new Map<string, Set<string>>();
  for (const e of input.effects) {
    if (e.createdAt < since) continue;
    if (!/write|edit/.test(e.tool)) continue;
    const set = countedByTarget.get(e.target) ?? new Set();
    // 只算"不同任务写同一个目标"的次数，这里用 state 区分不了，
    // 简化成按记录条数
    set.add(String(e.createdAt));
    countedByTarget.set(e.target, set);
    targetCount.set(e.target, (targetCount.get(e.target) ?? 0) + 1);
  }
  const repeatedTargets = [...targetCount.entries()]
    .filter(([, count]) => count >= 5)
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    days: input.days,
    executors: { total: recent.length, done, failed, cancelled },
    successRate: finished > 0 ? Math.round((done / finished) * 100) : null,
    topTools,
    topFailures,
    staleProjects,
    repeatedTargets,
  };
}

/** 渲染成给人看的多行文本。 */
export function renderUsage(stats: UsageStats): string {
  const lines: string[] = [`最近 ${stats.days} 天的使用情况`, ''];

  lines.push('## 任务');
  lines.push(`  派出 ${stats.executors.total} 个`);
  lines.push(`  完成 ${stats.executors.done} · 失败 ${stats.executors.failed} · 取消 ${stats.executors.cancelled}`);
  if (stats.successRate !== null) {
    lines.push(`  成功率 ${stats.successRate}%（按已结束的算）`);
  }
  lines.push('');

  if (stats.topTools.length > 0) {
    lines.push('## 用得最多的工具');
    for (const t of stats.topTools) lines.push(`  ${t.name.padEnd(16)} ${t.count} 次`);
    lines.push('');
  }

  if (stats.topFailures.length > 0) {
    lines.push('## 失败原因');
    for (const f of stats.topFailures) lines.push(`  ${f.reason.padEnd(16)} ${f.count} 次`);
    lines.push('');
  }

  if (stats.repeatedTargets.length > 0) {
    lines.push('## 反复改同一个目标');
    for (const r of stats.repeatedTargets) lines.push(`  ${r.target.slice(0, 40)} · ${r.count} 次`);
    lines.push('');
  }

  if (stats.staleProjects.length > 0) {
    lines.push('## 很久没动的项目');
    for (const p of stats.staleProjects) lines.push(`  ${p.name} · ${p.daysSince} 天`);
    lines.push('');
  }

  if (stats.executors.total === 0) {
    lines.push('这个时间段还没有派过任务。');
  }

  return lines.join('\n');
}
