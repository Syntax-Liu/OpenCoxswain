/**
 * 验收命令的平台兼容性检测。
 *
 * ## 为什么需要这个
 *
 * 实测（2026-11-15）：Assistant 在 Windows 上写出的验收命令大量是 POSIX 写法——
 * `test -f`、`grep -q`、`for … do … done`。它们在本机 cmd.exe 里
 * **命令根本不存在**，退出码非 0。
 *
 * 危险之处：验收框架把「命令非 0」判为 **failed**，
 * 而不是「命令无效」。于是：
 *   - 文件明明存在，却因为 `test` 不存在被判「未通过」；
 *   - 或者反过来，`grep` 不存在导致本该失败的检查「看起来跑过了」。
 *
 * 两种情况都会让「机器可判」变成假象。
 */

/** POSIX 专有命令（Windows cmd 里不存在）。 */
const POSIX_ONLY = [
  'test', 'grep', 'sed', 'awk', 'find', 'xargs', 'cat', 'ls', 'rm', 'cp', 'mv',
  'chmod', 'bash', 'sh', 'which', 'head', 'tail', 'wc', 'sort', 'uniq',
];

/** 明显是跨平台的（node / git / pnpm / npx / npm / tsc）。 */
const CROSS_PLATFORM = ['node', 'git', 'pnpm', 'npx', 'npm', 'tsc', 'yarn'];

/**
 * 判断一条验收命令在当前平台能否执行。
 *
 * @param {string} command
 * @param {NodeJS.Platform} platform
 * @returns {{ usable: boolean, reason?: string }}
 */
export function checkCommandUsable(command, platform = process.platform) {
  const cmd = command.trim();
  if (!cmd) return { usable: false, reason: '空命令' };

  // POSIX 专有语法：for … do … done / if … fi / $( … )
  if (/;\s*do\b|\bdone\b|\bfi\b|\$\{?[A-Za-z_]/.test(cmd) && platform === 'win32') {
    return { usable: false, reason: '含 POSIX shell 控制结构（for/do/done/fi/$VAR），Windows cmd 不支持' };
  }

  // 取第一个"真正的命令"：跳过 cd xxx && 这类前缀
  const segments = cmd.split('&&').map((s) => s.trim()).filter(Boolean);
  const first = segments[0] ?? cmd;
  const firstWord = first.split(/\s+/)[0]?.toLowerCase() ?? '';

  if (CROSS_PLATFORM.includes(firstWord)) return { usable: true };

  if (platform === 'win32' && POSIX_ONLY.includes(firstWord)) {
    return { usable: false, reason: `「${firstWord}」在 Windows 上不存在（没有 bash）` };
  }

  // 其余：可以执行，但未知是否可靠
  return { usable: true };
}

/**
 * 从命令里提取它依赖的可执行程序（用于报告）。
 */
export function firstCommandOf(command) {
  const first = command.split('&&')[0]?.trim() ?? '';
  return first.split(/\s+/)[0] ?? '';
}
