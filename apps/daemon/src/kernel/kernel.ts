import type {
  OpenCoxswainConfig,
  Permission,
  PluginContext,
  PluginDisposer,
  PluginManifest,
  PluginModule,
  ServiceKey,
  ServiceMap,
} from '@opencoxswain/plugin-api';
import { EventBus } from '../bus.js';
import { orderManifests } from './loader.js';

export interface ServiceRegistration {
  provider: string;
  value: unknown;
  required: Permission[];
  providerPermissions: Permission[];
}

const SERVICE_RULES: Record<
  ServiceKey,
  { required: Permission[]; provider: Permission[] }
> = {
  config: { required: [], provider: [] },
  events: { required: ['events:read', 'events:publish'], provider: [] },
  storage: {
    required: ['storage:read', 'storage:write'],
    provider: ['storage:provide', 'fs:data'],
  },
  worktrees: {
    required: ['fs:worktree', 'process:spawn'],
    provider: ['fs:worktree', 'process:spawn'],
  },
  runtimes: {
    required: ['runtime:use'],
    provider: ['runtime:provide'],
  },
  employees: {
    required: ['employee:use'],
    provider: ['employee:provide'],
  },
  verification: {
    required: ['verification:run'],
    provider: ['verification:provide'],
  },
  supervisor: {
    required: ['supervisor:use'],
    provider: ['supervisor:provide'],
  },
  planner: { required: ['planner:use'], provider: ['planner:use'] },
  scheduler: { required: ['scheduler:control'], provider: ['scheduler:control'] },
  steward: { required: ['steward:call'], provider: ['steward:call'] },
  secrets: {
    required: ['secrets:read'],
    provider: ['secrets:provide', 'fs:data'],
  },
  http: { required: ['http:route'], provider: ['net:listen', 'http:route'] },
};

class PluginContextImpl implements PluginContext {
  private readonly allowed: Set<ServiceKey>;
  private readonly disposers: PluginDisposer[] = [];

  constructor(
    private readonly kernel: Kernel,
    readonly manifest: PluginManifest,
  ) {
    this.allowed = new Set(manifest.inject);
  }

  get id(): string {
    return this.manifest.id;
  }

  get config(): Readonly<OpenCoxswainConfig> {
    return this.kernel.config;
  }

  service<K extends ServiceKey>(key: K): ServiceMap[K] {
    if (!this.allowed.has(key)) {
      throw new Error(`插件 ${this.id} 未在 inject 中声明服务 ${key}`);
    }
    const registration = this.kernel.lookup(key);
    this.requireAll(registration.required, `消费服务 ${key}`);
    return registration.value as ServiceMap[K];
  }

  provide<K extends ServiceKey>(key: K, value: ServiceMap[K]): void {
    if (!this.manifest.provides.includes(key)) {
      throw new Error(`插件 ${this.id} 未在 provides 中声明服务 ${key}`);
    }
    const rule = SERVICE_RULES[key];
    this.requireAll(rule.provider, `提供服务 ${key}`);
    this.kernel.setService(key, value, this.manifest.id, rule);
  }

  effect(dispose: PluginDisposer): void {
    this.disposers.push(dispose);
  }

  on(event: string, listener: (payload: unknown) => void | Promise<void>): PluginDisposer {
    this.requirePermission('events:read');
    const off = this.kernel.events.on(event, listener);
    this.effect(off);
    return off;
  }

  emit(event: string, payload: unknown): void {
    this.requirePermission('events:publish');
    this.kernel.events.emit(event, payload);
  }

  requirePermission(permission: Permission): void {
    if (!this.manifest.permissions.includes(permission)) {
      throw new Error(`插件 ${this.id} 缺少权限 ${permission}`);
    }
  }

  log(message: string, detail?: unknown): void {
    if (detail === undefined) console.log(`[${this.id}] ${message}`);
    else console.log(`[${this.id}] ${message}`, detail);
  }

  async dispose(): Promise<void> {
    for (const disposer of [...this.disposers].reverse()) {
      await disposer();
    }
    this.disposers.length = 0;
  }

  private requireAll(permissions: Permission[], action: string): void {
    for (const permission of permissions) {
      if (!this.manifest.permissions.includes(permission)) {
        throw new Error(`插件 ${this.id} 缺少权限 ${permission}，无法${action}`);
      }
    }
  }
}

interface LoadedPlugin {
  manifest: PluginManifest;
  context: PluginContextImpl;
}

export class Kernel {
  readonly events = new EventBus();
  private readonly services = new Map<ServiceKey, ServiceRegistration>();
  private readonly loaded: LoadedPlugin[] = [];
  private state: 'new' | 'started' | 'stopped' = 'new';

  constructor(readonly config: OpenCoxswainConfig) {
    this.services.set('config', {
      provider: 'kernel',
      value: config,
      required: [],
      providerPermissions: [],
    });
    this.services.set('events', {
      provider: 'kernel',
      value: this.events,
      required: SERVICE_RULES.events.required,
      providerPermissions: SERVICE_RULES.events.provider,
    });
  }

  async load(manifests: PluginManifest[]): Promise<void> {
    if (this.state !== 'new') throw new Error('内核已经启动，不能重复加载插件');
    const ordered = orderManifests(manifests);
    try {
      for (const manifest of ordered) {
        const module = (await import(manifest.entry)) as PluginModule;
        if (typeof module.apply !== 'function') {
          throw new Error(`插件 ${manifest.id} 的模块没有导出 apply`);
        }
        const context = new PluginContextImpl(this, manifest);
        const disposer = await module.apply(context, manifest.config);
        if (typeof disposer === 'function') context.effect(disposer);
        this.loaded.push({ manifest, context });
      }
    } catch (error) {
      await this.unloadAll();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error('内核已经启动');
    this.state = 'started';
    await this.events.parallel('kernel.ready', {});
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    await this.unloadAll();
    this.services.clear();
  }

  lookup<K extends ServiceKey>(key: K): ServiceRegistration {
    const registration = this.services.get(key);
    if (!registration) throw new Error(`服务 ${key} 尚未注册`);
    return registration;
  }

  service<K extends ServiceKey>(key: K): ServiceMap[K] {
    return this.lookup(key).value as ServiceMap[K];
  }

  setService<K extends ServiceKey>(
    key: K,
    value: ServiceMap[K],
    provider: string,
    rule: { required: Permission[]; provider: Permission[] },
  ): void {
    if (this.services.has(key)) {
      throw new Error(`服务 ${key} 已被 ${this.services.get(key)?.provider ?? '未知插件'} 注册`);
    }
    this.services.set(key, {
      provider,
      value,
      required: rule.required,
      providerPermissions: rule.provider,
    });
  }

  private async unloadAll(): Promise<void> {
    for (const plugin of [...this.loaded].reverse()) {
      try {
        await plugin.context.dispose();
      } catch (error) {
        console.error(`卸载插件 ${plugin.manifest.id} 失败`, error);
      }
    }
    this.loaded.length = 0;
  }
}
