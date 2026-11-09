import { useSyncExternalStore, type ComponentType } from 'react';

export type UiSlot = 'left' | 'center' | 'right' | 'bottom';

export interface UiPlugin {
  id: string;
  title: string;
  slot: UiSlot;
  order: number;
  render: ComponentType;
}

const SLOTS: UiSlot[] = ['left', 'center', 'right', 'bottom'];

export class UiRegistry {
  private readonly plugins = new Map<string, UiPlugin>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Record<UiSlot, UiPlugin[]> = { left: [], center: [], right: [], bottom: [] };

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
    const next: Record<UiSlot, UiPlugin[]> = { left: [], center: [], right: [], bottom: [] };
    for (const plugin of this.plugins.values()) next[plugin.slot].push(plugin);
    for (const slot of SLOTS) next[slot].sort((a, b) => a.order - b.order);
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function useUiPanels(registry: UiRegistry, slot: UiSlot): UiPlugin[] {
  return useSyncExternalStore(registry.subscribe, () => registry.list(slot));
}

export function PanelSlot({
  registry,
  slot,
}: {
  registry: UiRegistry;
  slot: UiSlot;
}): JSX.Element {
  const panels = useUiPanels(registry, slot);
  return (
    <>
      {panels.map((panel) => {
        const Panel = panel.render;
        return <Panel key={panel.id} />;
      })}
    </>
  );
}
