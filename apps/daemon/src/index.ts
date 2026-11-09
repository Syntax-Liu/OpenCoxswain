import { startDaemon } from './app.js';

async function main(): Promise<void> {
  const app = await startDaemon();
  console.log(`[opencoxswain] daemon http://${app.config.host}:${app.port}`);
  console.log(`[opencoxswain] home ${app.config.homeDir}`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('[opencoxswain] daemon failed:', error);
  process.exit(1);
});
