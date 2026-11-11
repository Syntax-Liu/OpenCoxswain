/**
 * 测试替身：内存版的 storage-domain、subagent 运行时与 agent 注册表。
 *
 * 刻意实现成与 dsh 相同的**语义**（而不是照抄内部结构）：
 * - domain 读同步、写返回 Promise；
 * - startActivation 立刻返回 activation，result 之后才 settle；
 * - 结算后才释放并发槽位（这是闸门正确性的关键点）；
 * - `agents.get()` 取不到返回 undefined（重启后的常态）；
 * - `followup` 投递到队列、**不打断**（P0-T4 语义）。
 */
import type {
  AgentHandleLike,
  AgentRegistryLike,
  CreateAgentOptionsLike,
  DomainLike,
  KvTableLike,
  ResumeAgentOptionsLike,
  StorageDomainFacilityLike,
  SubagentActivationLike,
  SubagentActivationSpecLike,
  SubagentResultLike,
  SubagentRuntimeLike,
} from '../host.js';
import type { Agent } from '../host-types.js';

class MemoryTable<V> implements KvTableLike<V> {
  private readonly map = new Map<string, V>();

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return [...this.map.entries()][Symbol.iterator]();
  }

  keys(): IterableIterator<string> {
    return [...this.map.keys()][Symbol.iterator]();
  }

  get size(): number {
    return this.map.size;
  }

  async put(key: string, value: V): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.map.get(key);
    if (current === undefined) {
      throw new Error(`missing-key: ${key}`);
    }
    const next = fn(current);
    this.map.set(key, structuredClone(next));
    return next;
  }
}

class MemoryDomain implements DomainLike {
  readonly name: string;
  private readonly tables = new Map<string, MemoryTable<never>>();
  closed = false;

  constructor(name: string, tableNames: readonly string[]) {
    this.name = name;
    for (const table of tableNames) {
      this.tables.set(table, new MemoryTable<never>());
    }
  }

  table(name: string): KvTableLike<never> {
    if (this.closed) throw new Error('closed');
    const table = this.tables.get(name);
    if (!table) throw new Error(`未声明的表：${name}`);
    return table;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface MemoryFacility extends StorageDomainFacilityLike {
  /** 已打开的域，供测试断言与复用。 */
  readonly domains: Map<string, MemoryDomain>;
}

export function makeMemoryFacility(): MemoryFacility {
  const domains = new Map<string, MemoryDomain>();
  return {
    domains,
    async open(spec: unknown): Promise<DomainLike> {
      const parsed = spec as { name: string; tables: Record<string, unknown> };
      const existing = domains.get(parsed.name);
      if (existing && !existing.closed) {
        throw new Error(`already-open: ${parsed.name}`);
      }
      const domain = new MemoryDomain(parsed.name, Object.keys(parsed.tables));
      domains.set(parsed.name, domain);
      return domain;
    },
  };
}

export interface StartedActivation {
  readonly spec: SubagentActivationSpecLike;
  readonly childId: string;
  /** 手动结算：让 result 以给定结果 resolve。 */
  settle(result: SubagentResultLike): void;
  /** 手动让 result reject。 */
  fail(error: Error): void;
}

export interface FakeSubagents extends SubagentRuntimeLike {
  readonly started: StartedActivation[];
  /** 让所有新起的 activation 自动在 microtask 后结算。 */
  autoSettle(result?: SubagentResultLike): void;
}

export function makeFakeSubagents(): FakeSubagents {
  const started: StartedActivation[] = [];
  let auto: SubagentResultLike | null = null;
  let counter = 0;

  return {
    started,
    autoSettle(result) {
      auto = result ?? { output: [{ type: 'text', text: '完成' }], stopReason: 'completed' };
    },
    async startActivation(spec: SubagentActivationSpecLike): Promise<SubagentActivationLike> {
      counter += 1;
      const childId = `child_${counter}`;
      let resolveResult!: (value: SubagentResultLike) => void;
      let rejectResult!: (error: Error) => void;
      const result = new Promise<SubagentResultLike>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const record: StartedActivation = {
        spec,
        childId,
        settle: (value) => resolveResult(value),
        fail: (error) => rejectResult(error),
      };
      started.push(record);
      if (auto) {
        const snapshot = auto;
        queueMicrotask(() => resolveResult(snapshot));
      }
      return {
        childId,
        messageId: `msg_${counter}`,
        result,
        dispose: async () => {
          // 与上游一致：dispose 让在途工作收敛，result 仍会 settle（aborted）。
          resolveResult({
            output: [],
            stopReason: 'aborted',
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Agent 注册表替身
// ---------------------------------------------------------------------------

/** 记录一次 `followup` 投递。 */
export interface RecordedDelivery {
  readonly sessionId: string;
  readonly message: unknown;
}

export interface FakeAgentRegistry extends AgentRegistryLike {
  /** 每个会话收到的 followup 消息，按投递顺序。 */
  readonly deliveries: RecordedDelivery[];
  /** 已撤销的会话 id。 */
  readonly disposed: string[];
  /** 模拟"重启"：清空注册表但保留持久化（用于验证取不到 + 恢复路径）。 */
  restart(): void;
  /** 预置一个持久化过的会话，模拟上一世存在的 C。 */
  seedPersisted(sessionId: string, opts?: { resumeFails?: boolean }): void;
}

export function makeFakeAgentRegistry(): FakeAgentRegistry {
  const live = new Map<string, Agent>();
  const deliveries: RecordedDelivery[] = [];
  const disposed: string[] = [];
  const persisted = new Map<string, { resumeFails: boolean }>();
  let counter = 0;

  function makeAgent(sessionId: string): Agent {
    return {
      id: sessionId,
      session: { id: sessionId },
      status: 'idle',
      followup(message: unknown) {
        deliveries.push({ sessionId, message });
      },
      steer() {
        throw new Error('测试替身未实现 steer');
      },
      cancel() {
        throw new Error('测试替身未实现 cancel');
      },
      async whenIdle() {
        return;
      },
    };
  }

  function handleFor(sessionId: string): AgentHandleLike {
    const agent = makeAgent(sessionId);
    live.set(sessionId, agent);
    return {
      agent,
      async dispose() {
        live.delete(sessionId);
        disposed.push(sessionId);
      },
    };
  }

  return {
    deliveries,
    disposed,
    async create(options: CreateAgentOptionsLike): Promise<AgentHandleLike> {
      counter += 1;
      void counter;
      return handleFor(options.sessionId);
    },
    async resume(options: ResumeAgentOptionsLike): Promise<AgentHandleLike> {
      const record = persisted.get(options.resumeSessionId);
      if (!record) {
        throw new Error(`no persisted session: ${options.resumeSessionId}`);
      }
      if (record.resumeFails) {
        throw new Error('resume failed (模拟)');
      }
      return handleFor(options.resumeSessionId);
    },
    get(id: string): Agent | undefined {
      return live.get(id);
    },
    list(): Agent[] {
      return [...live.values()];
    },
    roots(): Agent[] {
      return [...live.values()];
    },
    restart() {
      live.clear();
    },
    seedPersisted(sessionId: string, opts?: { resumeFails?: boolean }) {
      persisted.set(sessionId, { resumeFails: opts?.resumeFails ?? false });
    },
  };
}
