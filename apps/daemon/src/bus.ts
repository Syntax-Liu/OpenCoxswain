import type { EventRecord } from '@opencoxswain/shared';

type Listener = (event: EventRecord) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: EventRecord): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
