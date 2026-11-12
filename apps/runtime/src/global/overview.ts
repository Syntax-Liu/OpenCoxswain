/**
 * General Manager（Supervisor）的跨项目能力。
 *
 * ## 为什么需要 B
 *
 * Project Manager（C）**只看得到自己那个项目**——这是它的全部职责范围。
 * 所以它结构上做不了这几件事：
 *
 * 1. 我手头三个项目都什么状态？
 * 2. 两个项目是不是在改同一个共享文件？
 * 3. 三个项目都在等我决定，先做哪个？
 * 4. 用户说过什么**跨项目**的规矩？
 *
 * 早期 B 只有"找项目 + 转交原话"，和 C 高度重复。
 * 现在改为只做这四件 C 做不到的事。
 *
 * ## 一条硬规矩
 *
 * **B 不碰单个项目的细节，也不替 C 汇报"已完成"。**
 * 它只知道"某项目在跑几个 Agent、卡在哪"，不知道具体在改哪一行。
 */
import type { ExecutorRow, ProjectRow, Store } from '../store/store.js';
import {
  findCrossProjectConflict,
  describeConflict,
  type AgentClaim,
  type CrossProjectConflict,
} from './cross-project.js';

/** 单个项目的概况（给 B 汇总用）。 */
export interface ProjectOverview {
  readonly projectId: string;
  readonly name: string;
  readonly rootPath: string;
  readonly running: number;
  readonly queued: number;
  /** 需要用户决策的事。 */
  readonly needsUser: number;
  /** 等待审批的危险动作数。 */
  readonly pendingApprovals: number;
  /** 最近一次活动时间。 */
  readonly lastActivityAt: number;
  /** 一句话状态。 */
  readonly state: 'idle' | 'working' | 'blocked';
}

/** 全局视图：所有项目的汇总。 */
export interface GlobalOverview {
  readonly projects: readonly ProjectOverview[];
  /** 需要用户处理的总数（跨项目累加）。 */
  readonly totalNeedsUser: number;
  readonly totalRunning: number;
  /** 跨项目写域冲突。 */
  readonly conflicts: readonly {
    readonly overlap: string;
    readonly a: { projectId: string; label: string };
    readonly b: { projectId: string; label: string };
  }[];
}

function isRunning(status: ExecutorRow['status']): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * 汇总所有项目的状态。
 *
 * 这是 B 的核心数据源：C 看不到别的项目，B 看得到全部。
 */
export function buildGlobalOverview(store: Store): GlobalOverview {
  const projects = store.listProjects().map((project): ProjectOverview => {
    const agents = store.listExecutors({ projectId: project.id });
    const running = agents.filter((a) => isRunning(a.status)).length;
    const queued = agents.filter((a) => a.status === 'starting').length;
    const needsUser = store.listReports({ projectId: project.id, needsUser: true }).length;
    const pendingApprovals = store.listApprovals({ projectId: project.id, status: ['pending'] })
      .length;

    const lastActivityAt = agents.reduce((max, a) => Math.max(max, a.endedAt ?? a.createdAt), 0);

    // 状态判定：有要你决定的 → blocked；有在跑 → working；否则 idle
    const state: ProjectOverview['state'] =
      needsUser > 0 || pendingApprovals > 0 ? 'blocked' : running > 0 ? 'working' : 'idle';

    return {
      projectId: project.id,
      name: project.name,
      rootPath: project.rootPath,
      running,
      queued,
      needsUser,
      pendingApprovals,
      lastActivityAt,
      state,
    };
  });

  return {
    projects,
    totalNeedsUser: projects.reduce((n, p) => n + p.needsUser + p.pendingApprovals, 0),
    totalRunning: projects.reduce((n, p) => n + p.running, 0),
    conflicts: collectConflicts(store),
  };
}

/** 收集当前所有跨项目写域冲突。 */
export function collectConflicts(store: Store): GlobalOverview['conflicts'] {
  const claims: AgentClaim[] = [];

  for (const project of store.listProjects()) {
    for (const agent of store.listExecutors({ projectId: project.id })) {
      if (!isRunning(agent.status)) continue;
      claims.push({
        projectId: project.id,
        projectRoot: project.displayPath,
        agentId: agent.id,
        label: agent.label,
        writeScope: agent.writeScope,
        readonly: agent.access === 'readonly',
      });
    }
  }

  const found: Array<GlobalOverview['conflicts'][number]> = [];
  const seen = new Set<string>();

  for (const claim of claims) {
    const conflict = findCrossProjectConflict(
      claim,
      claims.filter((c) => c.agentId !== claim.agentId),
    );
    if (!conflict) continue;

    // 同一对只报一次（A 看到 B、B 看到 A 是同一个冲突）
    const key = [claim.agentId, conflict.withAgentId].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({
      overlap: conflict.overlap,
      a: { projectId: claim.projectId, label: claim.label },
      b: { projectId: conflict.withProjectId, label: conflict.withLabel },
    });
  }
  return found;
}

/**
 * 检查某个新 Agent 是否会跨项目冲突。
 *
 * 由 Project Manager 派活前调用；有冲突就应当拒绝并说明原因。
 */
export function checkBeforeSpawn(
  store: Store,
  project: ProjectRow,
  input: { agentId: string; label: string; writeScope: readonly string[]; readonly: boolean },
): CrossProjectConflict | null {
  const candidate: AgentClaim = {
    projectId: project.id,
    projectRoot: project.displayPath,
    agentId: input.agentId,
    label: input.label,
    writeScope: input.writeScope,
    readonly: input.readonly,
  };

  const running: AgentClaim[] = [];
  for (const other of store.listProjects()) {
    if (other.id === project.id) continue;
    for (const agent of store.listExecutors({ projectId: other.id })) {
      if (!isRunning(agent.status)) continue;
      running.push({
        projectId: other.id,
        projectRoot: other.displayPath,
        agentId: agent.id,
        label: agent.label,
        writeScope: agent.writeScope,
        readonly: agent.access === 'readonly',
      });
    }
  }

  return findCrossProjectConflict(candidate, running);
}

/**
 * 优先级裁决：多个项目都在等用户时，谁该先处理。
 *
 * 排序依据（越靠前越该先做）：
 * 1. 有危险动作待审批（阻塞最久、后果最直接）
 * 2. 有 Agent 已停下等用户决定
 * 3. 最近有活动的（说明用户正在关注）
 */
export function prioritize(overview: GlobalOverview): ProjectOverview[] {
  return [...overview.projects]
    .filter((p) => p.state === 'blocked')
    .sort((a, b) => {
      if (a.pendingApprovals !== b.pendingApprovals) return b.pendingApprovals - a.pendingApprovals;
      if (a.needsUser !== b.needsUser) return b.needsUser - a.needsUser;
      return b.lastActivityAt - a.lastActivityAt;
    });
}

/** 把全局视图写成人话（B 对用户说的话）。 */
export function describeOverview(overview: GlobalOverview): string {
  if (overview.projects.length === 0) {
    return '还没有打开任何项目。';
  }

  const lines: string[] = [];
  const running = overview.projects.filter((p) => p.state === 'working');
  const blocked = overview.projects.filter((p) => p.state === 'blocked');
  const idle = overview.projects.filter((p) => p.state === 'idle');

  if (blocked.length > 0) {
    lines.push(`**${blocked.length} 个项目在等你**：`);
    for (const p of prioritize(overview)) {
      const parts: string[] = [];
      if (p.pendingApprovals > 0) parts.push(`${p.pendingApprovals} 个动作待审批`);
      if (p.needsUser > 0) parts.push(`${p.needsUser} 件事待决定`);
      lines.push(`- ${p.name}：${parts.join('，')}`);
    }
  }

  if (running.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`**${running.length} 个项目在跑**：`);
    for (const p of running) {
      lines.push(`- ${p.name}：${p.running} 个执行者在工作`);
    }
  }

  if (idle.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`其余 ${idle.length} 个项目空闲。`);
  }

  if (overview.conflicts.length > 0) {
    lines.push('');
    lines.push('⚠ **发现跨项目写冲突**：');
    for (const c of overview.conflicts) {
      lines.push(`- ${c.a.label} ↔ ${c.b.label}：${c.overlap}`);
    }
    lines.push('两个项目同时改同一份文件会互相覆盖，建议先停一个。');
  }

  return lines.join('\n');
}

/** 跨项目冲突的可读描述（复用模块内实现）。 */
export { describeConflict };
