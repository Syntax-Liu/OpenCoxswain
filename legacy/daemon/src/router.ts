import { tokenize } from '@opencoxswain/memory';
import type { MemoryService, RouterService, StorageService } from '@opencoxswain/plugin-api';
import type { RouteSuggestion } from '@opencoxswain/shared';
import { AppError } from './errors.js';

/** 打分权重：项目名/路径最可信，其次是项目记忆，最后是最近任务。 */
const NAME_WEIGHT = 3;
const MEMORY_WEIGHT = 2;
const TASK_WEIGHT = 1;
const MAX_SUGGESTIONS = 3;
const MAX_REASONS = 3;
const RECENT_TASKS = 5;

export interface RouterDeps {
  store: StorageService;
  memory: MemoryService;
  log?: (message: string, detail?: unknown) => void;
}

function hits(tokens: string[], text: string): string[] {
  const haystack = text.toLowerCase();
  return tokens.filter((token) => haystack.includes(token));
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/**
 * 全局路由：用本地规则把目标映射到已有项目，只给建议与依据，不建单、不改状态。
 * 不做语义模型推断，避免把活悄悄派到错的项目。
 */
export class GoalRouter implements RouterService {
  constructor(private readonly deps: RouterDeps) {}

  route(goal: string): RouteSuggestion[] {
    const text = goal.trim();
    if (text === '') throw new AppError('目标不能为空');
    const tokens = [...new Set(tokenize(text))];
    if (tokens.length === 0) return [];

    const suggestions = this.deps.store
      .listProjects()
      .map((project) => {
        const reasons: string[] = [];
        let score = 0;

        const scopeHits = hits(tokens, `${project.name} ${project.path}`);
        if (scopeHits.length > 0) {
          score += scopeHits.length * NAME_WEIGHT;
          reasons.push(`项目名或路径命中「${scopeHits.slice(0, 2).join('、')}」`);
        }

        let memoryHits = 0;
        for (const entry of this.deps.memory.list(project.id)) {
          if (hits(tokens, entry.text).length === 0) continue;
          memoryHits += 1;
          score += MEMORY_WEIGHT;
          if (memoryHits <= 2) reasons.push(`项目记忆提到「${preview(entry.text)}」`);
        }

        const recent = this.deps.store
          .listRootTasks(project.id)
          .slice()
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, RECENT_TASKS);
        let taskHits = 0;
        for (const task of recent) {
          if (hits(tokens, `${task.title} ${task.goal}`).length === 0) continue;
          taskHits += 1;
          score += TASK_WEIGHT;
          if (taskHits <= 1) reasons.push(`最近任务「${preview(task.title)}」`);
        }

        return {
          projectId: project.id,
          projectName: project.name,
          score,
          reasons: reasons.slice(0, MAX_REASONS),
        };
      })
      .filter((suggestion) => suggestion.score > 0);

    suggestions.sort(
      (left, right) =>
        right.score - left.score || left.projectName.localeCompare(right.projectName),
    );
    return suggestions.slice(0, MAX_SUGGESTIONS);
  }
}
