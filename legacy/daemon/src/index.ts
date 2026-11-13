import { startDaemon } from './app.js';

async function main(): Promise<void> {
  const app = await startDaemon();
  console.log(`[opencoxswain] daemon http://${app.config.host}:${app.port}`);
  console.log(`[opencoxswain] home ${app.config.homeDir}`);

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // 进程内崩溃同样要走一次卸载，否则运行中的 OpenCode / 验收命令会变成孤儿进程。
  process.on('uncaughtException', (error) => {
    console.error('[opencoxswain] uncaughtException:', error);
    void shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[opencoxswain] unhandledRejection:', reason);
    void shutdown(1);
  });
}

main().catch((error: unknown) => {
  console.error('[opencoxswain] daemon failed:', error);
  process.exit(1);
});
