/**
 * 扩展示例：可以复制到 ~/.opencoxswain/extensions/ 直接用。
 *
 * 用途演示：
 * 1. 本机策略拦截（比审批更早，属于"这台机器一律不许"）
 * 2. 观察日志（工具都跑了什么）
 *
 * 说明：这个文件本身不会自动生效，必须放到扩展目录并重启运行时。
 */

export default function (api) {
  // ---- 1. 本机策略：这台机器一律不许 sudo / 关机 ----
  const BANNED = [/\bsudo\b/i, /\bshutdown\b/i, /\bformat\b\s+[a-z]:/i];

  api.beforeTool(({ tool, args }) => {
    if (tool !== 'run_command') return;

    const command = String(args.command ?? '');
    const hit = BANNED.find((re) => re.test(command));
    if (hit) {
      return { veto: true, reason: `本机策略禁止这类命令（匹配 ${hit}）` };
    }
  });

  // ---- 2. 观察：记录每个工具调用 ----
  const started = new Map();

  api.beforeTool(({ tool }) => {
    started.set(tool, Date.now());
  });

  api.afterTool(({ tool, ok }) => {
    const cost = Date.now() - (started.get(tool) ?? Date.now());
    started.delete(tool);
    console.log(`[trace] ${tool} → ${ok ? 'ok' : 'fail'} (${cost}ms)`);
  });
}
