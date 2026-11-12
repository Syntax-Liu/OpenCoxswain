/**
 * 任务模板。
 *
 * ## 为什么需要
 *
 * 用户每次派活都要重新交代"要改哪些文件、怎么算做完"。
 * 套路其实是重复的：修缺陷、加小功能、写文档、重构、调研。
 *
 * ## 一条硬约束（比功能本身更重要）
 *
 * **模板只是"预填"，不是"放行"。**
 *
 * 套用模板之后，任务仍然停在待确认状态，用户要按一次才真的派出去。
 * 如果把模板做成"点了就自动跑"，就破坏了整个产品的前提：
 * 人拍板。这条约束由测试守着。
 */
import type { AcceptancePolicy, Criterion } from '../acceptance/criteria.js';

export interface TaskTemplate {
  readonly id: string;
  readonly name: string;
  /** 一句话说明这个模板适合什么场景。 */
  readonly whenToUse: string;
  /** 目标提示，`{}` 处留给用户填。 */
  readonly goalHint: string;
  /** 建议的写域（相对路径）。空数组表示"由用户决定"。 */
  readonly writeScope: readonly string[];
  /** 建议的验收标准。 */
  readonly criteria: readonly Criterion[];
  readonly policy: AcceptancePolicy;
  /** 是否建议只读（调研类）。 */
  readonly readonly?: boolean;
}

/**
 * 内置模板。
 *
 * 每个模板的验收标准都遵循一个原则：
 * **能自动验的就自动验**，人只判断真正需要判断的部分。
 */
export const TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'fix-bug',
    name: '修缺陷',
    whenToUse: '某个功能坏了，需要定位并修好',
    goalHint: '修复：{现象}\n复现步骤：{怎么复现}\n期望行为：{应该怎样}',
    writeScope: [],
    criteria: [
      {
        id: 'tests',
        desc: '相关测试通过',
        type: 'command',
        check: 'pnpm test',
      },
      {
        id: 'scope',
        desc: '确实改了代码',
        type: 'diff',
      },
    ],
    policy: 'unverified_only',
  },
  {
    id: 'small-feature',
    name: '加小功能',
    whenToUse: '一个边界清楚、不需要大改架构的功能',
    goalHint: '新增功能：{做什么}\n边界：{明确不做什么}\n验收：{怎么算完成}',
    writeScope: [],
    criteria: [
      { id: 'typecheck', desc: '类型检查通过', type: 'command', check: 'pnpm typecheck' },
      { id: 'tests', desc: '测试通过', type: 'command', check: 'pnpm test' },
      { id: 'scope', desc: '确实写了代码', type: 'diff' },
    ],
    policy: 'unverified_only',
  },
  {
    id: 'docs',
    name: '写文档',
    whenToUse: '补 README、写设计说明、整理调研记录',
    goalHint: '写文档：{主题}\n位置：{写到哪个文件}\n要点：{必须覆盖的几点}',
    writeScope: ['docs/'],
    criteria: [
      {
        id: 'written',
        desc: '确实写了内容',
        type: 'diff',
      },
      {
        id: 'review',
        desc: '内容准确、可读',
        type: 'human',
      },
    ],
    policy: 'unverified_only',
  },
  {
    id: 'refactor',
    name: '重构',
    whenToUse: '不改行为，只改善结构',
    goalHint: '重构：{哪个模块}\n目标：{要解决什么问题}\n**不得改变行为**',
    writeScope: [],
    criteria: [
      { id: 'tests', desc: '测试仍然全过（行为没变）', type: 'command', check: 'pnpm test' },
      { id: 'typecheck', desc: '类型检查通过', type: 'command', check: 'pnpm typecheck' },
      { id: 'scope', desc: '确实改了代码', type: 'diff' },
    ],
    policy: 'unverified_only',
  },
  {
    id: 'research',
    name: '调研（只读）',
    whenToUse: '查清一个问题的原因，不改任何文件',
    goalHint: '调研：{要查清什么}\n范围：{看哪些地方}\n产出：结论 + 依据（不要改代码）',
    writeScope: ['readonly'],
    criteria: [
      {
        id: 'conclusion',
        desc: '给出了结论和依据',
        type: 'human',
      },
    ],
    policy: 'unverified_only',
    readonly: true,
  },
];

/** 按 id 找模板。 */
export function findTemplate(id: string): TaskTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * 套用模板生成"待确认"的派活草稿。
 *
 * **返回的是草稿，不是已派出的任务。** 调用方必须让用户确认后才真正 spawn。
 */
export interface AppliedTemplate {
  readonly templateId: string;
  readonly label: string;
  readonly goal: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly Criterion[];
  readonly policy: AcceptancePolicy;
  readonly readonly: boolean;
  /** 必须为 true：模板永不自动放行。 */
  readonly requiresConfirmation: true;
}

export function applyTemplate(
  template: TaskTemplate,
  input: { label: string; goal: string },
): AppliedTemplate {
  return {
    templateId: template.id,
    label: input.label.trim() || template.name,
    goal: input.goal.trim(),
    writeScope: template.writeScope,
    criteria: template.criteria,
    policy: template.policy,
    readonly: template.readonly === true,
    requiresConfirmation: true,
  };
}
