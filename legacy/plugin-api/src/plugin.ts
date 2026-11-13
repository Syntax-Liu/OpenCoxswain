import type {
  OpenCoxswainConfig,
  Permission,
  PluginKind,
  ServiceKey,
  ServiceMap,
} from './contracts.js';

export type PluginDisposer = () => void | Promise<void>;

export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  entry: string;
  provides: ServiceKey[];
  inject: ServiceKey[];
  permissions: Permission[];
  enabled?: boolean;
  config?: unknown;
}

export interface PluginContext {
  readonly id: string;
  readonly config: Readonly<OpenCoxswainConfig>;
  service<K extends ServiceKey>(key: K): ServiceMap[K];
  provide<K extends ServiceKey>(key: K, value: ServiceMap[K]): void;
  effect(dispose: PluginDisposer): void;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): PluginDisposer;
  emit(event: string, payload: unknown): void;
  requirePermission(permission: Permission): void;
  log(message: string, detail?: unknown): void;
}

export interface PluginModule {
  apply(ctx: PluginContext, config: unknown): void | Promise<void> | PluginDisposer;
}
