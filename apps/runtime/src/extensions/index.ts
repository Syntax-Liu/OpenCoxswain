/**
 * 扩展口（给 geek 的自定义点）。
 *
 * ## 设计立场
 *
 * 这不是插件系统。**不需要写清单、不需要注册、不需要打包**——
 * 只是想改行为的人，往一个文件夹里丢一个 JS 文件就行。
 *
 * 为什么要这么简单：插件系统要付出生命周期、依赖注入、版本兼容的复杂度，
 * 而我们没有第三方生态。geek 要的是"能在不 fork 的前提下改一点行为"，
 * 不是"做一个生态"。
 *
 * ## 三个扩展点
 *
 * | 扩展点 | 能做什么 | 不能做什么 |
 * | --- | --- | --- |
 * | `beforeTool` | 否决一个工具调用 | 改参数（会破坏副作用台账的真实性） |
 * | `afterTool` | 观察、记录、上报 | 改变结果 |
 * | `onEvent` | 观察运行事件 | 影响流程 |
 *
 * ## 安全边界（故意留的限制）
 *
 * - 扩展代码**跑在运行时进程里**，和主程序同权。它能让程序崩溃，
 *   所以加载失败或抛异常都**只记日志、不中断主流程**。
 * - **不提供**修改写域、跳过审批、绕过验收的钩子。
 *   这些是产品的信任基础，不允许被扩展绕开。
 *
 * ## 怎么用
 *
 * 把 `.js` 文件放到 `~/.opencoxswain/extensions/`，导出 `default` 函数：
 *
 * ```js
 * // ~/.opencoxswain/extensions/audit.js
 * export default function (api) {
 *   api.beforeTool(({ tool, args }) => {
 *     if (tool === 'run_command' && String(args.command).includes('sudo')) {
 *       return { veto: true, reason: '本机策略：不允许 sudo' };
 *     }
 *   });
 * }
 * ```
 *
 * 改完重启生效（故意不做热加载：热加载会让"当前行为"变得难以复述）。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 扩展可以注册的回调。参数刻意做得小且明确。 */
export interface ExtensionApi {
  /** 工具即将执行时调用；返回 `{ veto: true }` 可阻止。 */
  beforeTool(handler: (input: {
    tool: string;
    args: Record<string, unknown>;
  }) => { veto: true; reason: string } | void): void;
  /** 工具执行结束后调用，仅用于观察。 */
  afterTool(handler: (input: {
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
  }) => void): void;
}

export interface LoadedExtensions {
  readonly beforeTool: ReadonlyArray<NonNullable<ExtensionHook['beforeTool']>>;
  readonly afterTool: ReadonlyArray<NonNullable<ExtensionHook['afterTool']>>;
  /** 加载过程中的问题，展示给用户（不抛异常）。 */
  readonly problems: readonly string[];
  readonly names: readonly string[];
}

interface ExtensionHook {
  readonly beforeTool: Array<
    (input: { tool: string; args: Record<string, unknown> }) =>
      | { veto: true; reason: string }
      | void
  >;
  readonly afterTool: Array<
    (input: { tool: string; args: Record<string, unknown>; ok: boolean }) => void
  >;
}

/** 默认扩展目录。 */
export function extensionsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  const base = process.env.OPENCOXSWAIN_HOME ?? path.join(home, '.opencoxswain');
  return path.join(base, 'extensions');
}

/**
 * 加载扩展。
 *
 * **任何一个扩展出错都不影响其它扩展，更不影响主程序**——
 * 用户可能只是写错了一个分号，不该因此打不开软件。
 */
export async function loadExtensions(dir = extensionsDir()): Promise<LoadedExtensions> {
  const beforeTool: Array<NonNullable<ExtensionHook['beforeTool']>> = [];
  const afterTool: Array<NonNullable<ExtensionHook['afterTool']>> = [];
  const problems: string[] = [];
  const names: string[] = [];

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).sort();
  } catch {
    // 目录不存在是常态（绝大多数用户不写扩展）。
    return { beforeTool, afterTool, problems, names };
  }

  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const module = (await import(pathToFileURL(file).href)) as {
        default?: unknown;
      };
      const factory = module.default;
      if (typeof factory !== 'function') {
        problems.push(`${entry}：没有导出 default 函数，已跳过`);
        continue;
      }

      // 同一个扩展可以注册多个回调：**累加，不覆盖**。
      // （早期实现用单槽存储，第二个 beforeTool 会覆盖第一个，
      // 导致示例里的"本机策略"静默失效——是测试抓到的。）
      const hook: ExtensionHook = { beforeTool: [], afterTool: [] };
      const api: ExtensionApi = {
        beforeTool(handler) {
          hook.beforeTool.push(handler);
        },
        afterTool(handler) {
          hook.afterTool.push(handler);
        },
      };

      // 同步调用，避免扩展写异步初始化导致加载顺序不确定。
      await factory(api);

      beforeTool.push(...hook.beforeTool);
      afterTool.push(...hook.afterTool);
      names.push(entry);
    } catch (error) {
      problems.push(`${entry}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { beforeTool, afterTool, problems, names };
}

/**
 * 依次询问所有扩展是否否决。
 *
 * 只要有一个否决就阻止——扩展是"额外的护栏"，
 * 任何一个说不行都应该听。
 */
export function collectVeto(
  hooks: LoadedExtensions,
  tool: string,
  args: Record<string, unknown>,
): { veto: true; reason: string } | null {
  for (const hook of hooks.beforeTool) {
    try {
      const result = hook({ tool, args });
      if (result && result.veto) return result;
    } catch {
      // 扩展自己出错不能卡住执行。
    }
  }
  return null;
}

/** 通知所有扩展工具执行完毕。 */
export function notifyAfterTool(
  hooks: LoadedExtensions,
  input: { tool: string; args: Record<string, unknown>; ok: boolean },
): void {
  for (const hook of hooks.afterTool) {
    try {
      hook(input);
    } catch {
      // 同上。
    }
  }
}
