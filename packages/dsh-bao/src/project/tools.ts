/**
 * 用户侧的项目操作：新建/打开项目 → 确保有常驻 C。
 *
 * 这是用户设想的**第一步**：
 * > "用户进入软件 -> 新建项目（如有项目，可以直接打开）"
 *
 * 这些工具给"用户入口"的会话（通常是 B，或 UI 直接调用）用，
 * 不涉及派活，只负责"把项目的 C 准备好"。
 */
import type { ToolDefinitionLike, LogFn } from '../assistant/tools.js';
import type { AssistantManager } from '../assistant/lifecycle.js';
import type { BaoStore } from '../store.js';
import { listProjects } from '../store.js';
import { deliver } from '../inbox/queue.js';

export interface ProjectToolDeps {
  readonly store: BaoStore;
  readonly assistants: AssistantManager;
  readonly log: LogFn;
}

function text(value: string): readonly unknown[] {
  return [{ type: 'text', text: value }];
}

export function buildProjectTools(deps: ProjectToolDeps): ToolDefinitionLike[] {
  return [openProjectTool(deps), listProjectsTool(deps)];
}

function openProjectTool({ assistants }: ProjectToolDeps): ToolDefinitionLike {
  return {
    name: 'open_project',
    description:
      '新建或打开一个项目：确保它有一个常驻的项目助理（C）。' +
      '已存在的项目会复用同一个 C；重启后会从会话恢复 C（完整恢复上下文）。' +
      '如果同时给了 firstMessage，会把它作为第一句话交给 C。',
    parameters: {
      rootPath: {
        type: 'string',
        required: true,
        description: '项目的绝对路径（该项目的根目录）',
      },
      name: { type: 'string', description: '项目显示名；缺省取路径最后一段' },
      firstMessage: {
        type: 'string',
        description: '可选：打开后立刻对 C 说的第一句话（用户原话）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          projectId: { type: 'string' },
          project: { type: 'string' },
          assistantSessionId: { type: 'string' },
          assistantLoaded: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok: boolean;
          project: string;
          assistantSessionId: string;
          assistantLoaded: boolean;
          message: string;
        };
        return text(
          v.ok
            ? `项目「${v.project}」已打开，项目助理 C 已就绪（${v.assistantSessionId}）。${v.message}`
            : v.message,
        );
      },
    },
    async execute(rawArgs) {
      const args = rawArgs as { rootPath: string; name?: string; firstMessage?: string };
      const opened = await assistants.openProject({
        rootPath: args.rootPath,
        ...(args.name ? { name: args.name } : {}),
      });

      if (!opened.ok) {
        return {
          ok: false,
          projectId: opened.project?.id ?? '',
          project: opened.project?.name ?? '',
          assistantSessionId: '',
          assistantLoaded: false,
          message: opened.reason,
        };
      }

      let message = '';
      if (args.firstMessage?.trim()) {
        // 连发不打断：第一句话同样排队，不打断任何正在进行的工作。
        const result = deliver({
          agent: opened.assistant.agent,
          text: args.firstMessage,
          source: { kind: 'user-open-project', projectId: opened.project.id },
        });
        message = result.ok ? `已转达：${result.message}` : `转达失败：${result.message}`;
      }

      return {
        ok: true,
        projectId: opened.project.id,
        project: opened.project.name,
        assistantSessionId: opened.assistant.sessionId,
        assistantLoaded: true,
        message,
      };
    },
  };
}

function listProjectsTool({ store, assistants }: ProjectToolDeps): ToolDefinitionLike {
  return {
    name: 'list_projects',
    description: '列出已接入的项目与它们的项目助理（C）状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          projects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                projectId: { type: 'string' },
                name: { type: 'string' },
                rootPath: { type: 'string' },
                assistantLoaded: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          total: number;
          projects: Array<{ name: string; projectId: string; rootPath: string; assistantLoaded: boolean }>;
        };
        if (!v.total) return text('还没有任何项目，先用 open_project 接入一个。');
        return text(
          `共 ${v.total} 个项目：\n` +
            v.projects
              .map((p) => `- ${p.name}（${p.projectId}）${p.rootPath} — ${p.assistantLoaded ? 'C 在线' : 'C 未加载'}`)
              .join('\n'),
        );
      },
    },
    async execute() {
      const projects = listProjects(store);
      return {
        total: projects.length,
        projects: projects.map((p) => ({
          projectId: p.id,
          name: p.name,
          rootPath: p.rootPath,
          assistantLoaded: assistants.getAssistant(p.id) !== undefined,
        })),
      };
    },
  };
}
