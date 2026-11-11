/**
 * 能力边界（capability boundary）。
 *
 * 这是给"万物皆插件"铺路的**第一步，也是最便宜的一步**：
 * 先把每个能力收成明确的接口，让核心只认接口、不认实现。
 *
 * ## 为什么现在只切边界，不直接上插件框架
 *
 * 插件框架（依赖注入、生命周期、清单驱动、热加载）是为**多来源贡献**准备的。
 * 现在所有能力都是自己写的，只有一个人维护——上框架等于为一个还不存在的问题
 * 付复杂度代价，而且会动摇刚做完的可信性（验收、审批、台账都依赖现有流程）。
 *
 * 边界切干净之后，将来要上插件系统，只需要**实现新的适配器**，
 * 业务代码一行都不用改。反过来（先上框架再补边界）返工量很大。
 *
 * ## 一条硬规矩
 *
 * **本文件不允许 import 任何具体实现。** 只有类型。
 * 这不是风格问题：一旦这里 import 了 `runExecutor`，
 * 核心就再也无法换成别的实现了。
 *
 * 对应的守护测试见 `test/boundary.test.ts`。
 */

// ---------------------------------------------------------------------------
// 1. 执行（谁来干活）
// ---------------------------------------------------------------------------

export interface ExecutorRequest {
  readonly rootPath: string;
  readonly projectName: string;
  readonly goal: string;
  readonly writeScope: readonly string[];
  /** 只读任务：硬性阻止写入。 */
  readonly readonlyTask?: boolean;
  readonly maxSteps?: number;
  readonly signal: AbortSignal;
  readonly priorMessages?: readonly unknown[];
  readonly commandTimeoutMs?: number;
  /** 中途注入的消息（连发不打断用）。 */
  readonly drainInputs?: () => readonly string[];
}

export interface ExecutorOutcomeLike {
  readonly ok: boolean;
  readonly finalText: string;
  readonly blockKind: string;
}

/**
 * 执行能力的契约。
 *
 * 默认实现是内建的 CLI 循环（`executor/executor.ts`），
 * 但接口刻意不暴露 LoopEvent 等细节——将来换成别的执行后端时，
 * 核心代码不需要知道。
 */
export interface ExecutorCapability {
  readonly name: string;
  run(request: ExecutorRequest): AsyncIterable<unknown> | Promise<ExecutorOutcomeLike>;
}

// ---------------------------------------------------------------------------
// 2. 记忆（记住什么）
// ---------------------------------------------------------------------------

export interface MemoryEntryView {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly source: string;
}

export interface MemoryCapability {
  readonly name: string;
  /** 读某个作用域的记忆。 */
  list(scope: 'global' | { project: string }): Promise<readonly MemoryEntryView[]>;
  /** 写入一条；返回失败原因时表示被门槛拒绝。 */
  write(
    scope: 'global' | { project: string },
    entry: { kind: string; text: string; source: string },
  ): Promise<{ ok: boolean; reason?: string }>;
  /** 删掉一条。 */
  remove(scope: 'global' | { project: string }, id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 3. 通知（怎么告诉用户）
// ---------------------------------------------------------------------------

export interface NotificationCapability {
  readonly name: string;
  /** 有结论要人看。 */
  report(input: { body: string; needsUser: boolean }): Promise<void>;
  /** 危险动作要人拍板。 */
  approval(input: { id: string; category: string; evidence: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// 4. 模型（用谁思考）
// ---------------------------------------------------------------------------

export interface ModelCapability {
  readonly name: string;
  /** 是否已配置（没配置时界面要提示去填密钥）。 */
  readonly configured: boolean;
}

// ---------------------------------------------------------------------------
// 5. 守卫（什么不许做）
// ---------------------------------------------------------------------------

export interface GuardCapability {
  readonly name: string;
  /** 执行前的检查；返回拒绝原因则不执行。 */
  check(input: {
    tool: string;
    args: Record<string, unknown>;
  }): { allow: true } | { allow: false; reason: string };
}

/** 一组能力的集合，方便整体替换与测试。 */
export interface Capabilities {
  readonly executor?: ExecutorCapability;
  readonly memory?: MemoryCapability;
  readonly notify?: readonly NotificationCapability[];
  readonly model?: ModelCapability;
  readonly guard?: GuardCapability;
}
