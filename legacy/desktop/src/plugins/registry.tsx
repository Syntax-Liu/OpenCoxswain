import { useSyncExternalStore, type ComponentType } from 'react';

export type UiSlot = 'page' | 'context';

export interface UiPlugin {
  id: string;
  title: string;
  slot: UiSlot;
  order: number;
  render: ComponentType;
}

const SLOTS: UiSlot[] = ['page', 'context'];

export class UiRegistry {
  private readonly plugins = new Map<string, UiPlugin>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Record<UiSlot, UiPlugin[]> = { page: [], context: [] };

  register(plugin: UiPlugin): () => void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`UI 插件 ${plugin.id} 已注册`);
    }
    this.plugins.set(plugin.id, plugin);
    this.refresh();
    return () => this.unregister(plugin.id);
  }

  unregister(id: string): void {
    if (this.plugins.delete(id)) this.refresh();
  }

  list(slot: UiSlot): UiPlugin[] {
    return this.snapshot[slot];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private refresh(): void {
    const next: Record<UiSlot, UiPlugin[]> = { page: [], context: [] };
    for (const plugin of this.plugins.values()) next[plugin.slot].push(plugin);
    for (const slot of SLOTS) next[slot].sort((a, b) => a.order - b.order);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function useUiPanels(registry: UiRegistry, slot: UiSlot): UiPlugin[] {
  return useSyncExternalStore(registry.subscribe, () => registry.list(slot));
}
