/**
 * Supervisor B：只做路由，不执行。
 *
 * 用户设想：
 * > "用户在主推流程外，可直接与 B 对话，B 会引导用户和哪一个 C 对接，
 * >  其余流程和主推流程一致，这个流程在用户有多个项目、
 * >  且不知道该向哪一个 C 发送任务时比较有效。"
 *
 * TRAE 宝的定位一致：
 * > "Supervisor：理解你的长期积累。它跨项目读取历史任务、对话和产物，
 * >  梳理相关方案、约束与偏好，为新任务准备好起点。"
 *
 * 三条硬边界（任何实现都不许越）：
 * 1. **不许自己派执行者** —— B 没有任何派活工具。
 * 2. **不许自己改代码**。
 * 3. **不许代 C 汇报"已完成"** —— B 只知道"我转交了"。
 */
import { newId, type ProjectRow, type Store } from '../store/store.js';
import type { Orchestrator } from '../orchestrator.js';

export interface RouteCandidate {
  readonly projectId: string;
  readonly name: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export type RouteDecision =
  | { readonly decision: 'unique'; readonly candidates: readonly RouteCandidate[]; readonly hint: string }
  | { readonly decision: 'ambiguous'; readonly candidates: readonly RouteCandidate[]; readonly hint: string }
  | { readonly decision: 'none'; readonly candidates: readonly []; readonly hint: string };

/**
 * 判断用户这句话属于哪个项目。
 *
 * **规则打分，不做语义模型推断**：给依据比给答案重要。
 * 依据来源：项目名命中、路径片段命中、最近执行者的标题/目标命中。
 */
export function findProject(
  store: Store,
  query: string,
  options: { readonly currentProjectId?: string } = {},
): RouteDecision {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { decision: 'none', candidates: [], hint: '请说明要推进哪件事。' };
  }

  const tokens = tokenize(needle);
  const scored: RouteCandidate[] = [];

  for (const project of store.listProjects()) {
    const reasons: string[] = [];
    let score = 0;

    const name = project.name.toLowerCase();
    if (name && needle.includes(name)) {
      score += 3;
      reasons.push(`项目名「${project.name}」出现在你的话里`);
    }

    const segments = project.rootPath.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length >= 2 && needle.includes(segment)) {
        score += 2;
        reasons.push(`路径片段「${segment}」出现在你的话里`);
        break;
      }
    }

    for (const executor of store.listExecutors({ projectId: project.id }).slice(-20)) {
      const haystack = `${executor.label} ${executor.goal}`.toLowerCase();
      const hit = tokens.filter((t) => haystack.includes(t));
      if (hit.length >= 2) {
        score += hit.length;
        reasons.push(`最近的执行者命中关键词：${hit.slice(0, 3).join('、')}`);
        break;
      }
    }

    // 当前正打开的项目作为弱先验，不作为决定性依据。
    if (options.currentProjectId === project.id && score > 0) {
      score += 1;
      reasons.push('这是你当前打开的项目');
    }

    if (score > 0) {
      scored.push({ projectId: project.id, name: project.name, score, reasons: reasons.slice(0, 3) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  if (top3.length === 0) {
    return {
      decision: 'none',
      candidates: [],
      hint: '没有项目命中这句话。请反问用户是哪个项目，不要猜测。',
    };
  }

  const top = top3[0]!;
  const tied = top3.filter((c) => c.score === top.score);
  if (tied.length > 1) {
    return {
      decision: 'ambiguous',
      candidates: top3,
      hint: `有 ${tied.length} 个项目等分，请反问用户而不是二选一硬转。`,
    };
  }

  return {
    decision: 'unique',
    candidates: top3,
    hint: `建议转交给「${top.name}」的Assistant。`,
  };
}

export interface HandoffResult {
  readonly ok: boolean;
  readonly project: string;
  readonly reason: string;
}

/**
 * 把用户的**原话原样**转交给目标项目的 C。
 *
 * 为什么不加工：B 一旦改写用户原话，C 就会在错误的前提上开工。
 */
export async function handoff(
  orchestrator: Orchestrator,
  store: Store,
  input: { readonly projectId: string; readonly userText: string },
): Promise<HandoffResult> {
  const project = store.getProject(input.projectId);
  if (!project) {
    return { ok: false, project: '', reason: `项目 ${input.projectId} 不存在` };
  }
  if (!input.userText.trim()) {
    return { ok: false, project: project.name, reason: '要转交的原话为空' };
  }

  // C 未加载是常态（重启后）——如实回报，不假装成功。
  const assistant = orchestrator.getAssistant(project.id);
  if (!assistant && store.getSession(project.assistantSessionId) === undefined) {
    return {
      ok: false,
      project: project.name,
      reason: `「${project.name}」还没有Assistant，请先打开该项目一次`,
    };
  }

  try {
    // 转交走默认的 next 队列：不打断 C 正在进行的工作。
    await orchestrator.userSays(project.id, input.userText, { source: 'global-assistant' });
  } catch (error) {
    return {
      ok: false,
      project: project.name,
      reason: `转交失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, project: project.name, reason: '' };
}

/** 跨项目简报：B 回答"现在都在干什么"。 */
export function projectBrief(store: Store): Array<{
  projectId: string;
  name: string;
  running: number;
  pending: number;
  lastReport: string;
}> {
  return store.listProjects().map((project) => {
    const executors = store.listExecutors({ projectId: project.id });
    const running = executors.filter((e) => e.status === 'running' || e.status === 'starting').length;
    const reports = store.listReports({ projectId: project.id, needsUser: true });
    const last = store.listReports({ projectId: project.id }).at(-1);
    return {
      projectId: project.id,
      name: project.name,
      running,
      pending: reports.length,
      lastReport: last?.body.slice(0, 200) ?? '',
    };
  });
}

/** 极简切词：中文按二元组，英文按空白与标点。 */
function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 2 <= word.length; i += 1) out.add(word.slice(i, i + 2));
    } else if (word.length >= 2) {
      out.add(word);
    }
  }
  return [...out];
}

export function newGlobalId(): string {
  return newId('b');
}

export type { ProjectRow };
