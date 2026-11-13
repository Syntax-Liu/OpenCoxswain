import type { EventRecord } from '@opencoxswain/shared';
import type { EventService } from '@opencoxswain/plugin-api';

type Listener = (event: EventRecord) => void;
type LifecycleListener = (payload: unknown) => void | Promise<void>;

export class EventBus implements EventService {
  private readonly listeners = new Set<Listener>();
  private readonly lifecycle = new Map<string, Set<LifecycleListener>>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: EventRecord): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  on(event: string, listener: LifecycleListener): () => void {
    const set = this.lifecycle.get(event) ?? new Set<LifecycleListener>();
    set.add(listener);
    this.lifecycle.set(event, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.lifecycle.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.lifecycle.get(event) ?? []) {
      const result = listener(payload);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error(`事件 ${event} 的监听器失败`, error);
        });
      }
    }
  }

  async parallel(event: string, payload: unknown): Promise<void> {
    const listeners = [...(this.lifecycle.get(event) ?? [])];
    await Promise.all(listeners.map((listener) => listener(payload)));
  }
}
