import type { EventRecord } from '@opencoxswain/shared';
import type { PluginContext } from '@opencoxswain/plugin-api';

export function apply(ctx: PluginContext): void {
  const http = ctx.service('http');
  const store = ctx.service('storage');
  const bus = ctx.service('events');
  const open = new Set<() => void>();

  http.rawRoute('GET', '/api/events', (req, res, url) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const write = (event: EventRecord): void => {
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
    for (const event of store.listEvents(null, Number.isFinite(after) ? after : 0, 500)) {
      write(event);
    }

    const unsubscribe = bus.subscribe(write);
    const keepalive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      open.delete(cleanup);
      if (!res.writableEnded) res.end();
    };

    open.add(cleanup);
    req.on('close', cleanup);
  });

  ctx.effect(() => {
    for (const cleanup of [...open]) cleanup();
  });
}
