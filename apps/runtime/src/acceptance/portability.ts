/**
 * 验收命令的可执行性判断。
 *
 * ## 为什么需要（实测踩到的坑）
 *
 * 2026-11-15 实测：Assistant 在 Windows 上写出的验收命令大量是 POSIX 写法——
 * `test -f`、`grep -q`、`for … do … done`。这些在本机 cmd.exe 里
 * **命令根本不存在**，退出码非 0。
 *
 * 而验收框架只认退出码：
 *   退出码 0 → passed，非 0 → failed
 *
 * 于是「命令不存在」被报成「检查没通过」：
 *
 *   test -f 存在.md        → 文件明明存在，却报「未通过」
 *   grep -q 关键内容 ...   → 内容明明有，却报「没找到」
 *
 * 用户看到的是「Agent 没干活」，实际是「验收命令写错了平台」。
 * 这种失败**不会报错、不会告警**，只会让每一步验收都安静地变红。
 *
 * ## 两层防护
 *
 * 1. **事前**：`checkCommandUsable()` —— 派活/验收前就知道跑不跑得了。
 * 2. **事后**：`looksLikeCommandNotFound()` —— 命令跑挂了，判断是
 *    「程序不存在」还是「检查真的没过」，避免把前者当后者。
 */
import { execSync } from 'node:child_process';

/**
 * Windows cmd.exe 里不存在的 POSIX 命令。
 *
 * 注意：**不要**把 `echo` / `cd` / `dir` / `copy` / `del` / `mkdir` / `type`
 * 这类放进来——它们是 cmd 内建命令，Windows 上本来就有。
 * 早期版本误把 echo 列入，导致「echo hello」这类正常命令被误判不可用，
 * 直接把两条验收测试打红。
 */
const POSIX_ONLY = new Set([
  'test', 'grep', 'sed', 'awk', 'find', 'xargs', 'cat', 'ls', 'rm', 'cp', 'mv',
  'chmod', 'chown', 'bash', 'sh', 'zsh', 'which', 'head', 'tail', 'wc',
  'sort', 'uniq', 'tr', 'diff', 'touch', 'tee', 'curl', 'wget', 'openssl',
  'env', 'true', 'false', 'printf', 'ln', 'du', 'df', 'ps', 'kill', 'tee',
]);

/** 明确跨平台、几乎一定可用的程序。 */
const CROSS_PLATFORM = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'git', 'tsc', 'python', 'python3',
  'mvn', 'gradle', 'dotnet', 'go', 'cargo', 'rustc', 'java', 'javac',
]);

export interface UsabilityResult {
  readonly usable: boolean;
  /** 不可用时给人看的原因。 */
  readonly reason?: string;
  /** 命令依赖的第一个可执行程序。 */
  readonly program: string;
}

/**
 * 取命令里第一个"真正的"程序名。
 *
 * 跳过 `cd xxx &&` 这种前缀——真正执行的是后面那段。
 */
export function firstProgramOf(command: string): string {
  const segments = command
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const seg of segments) {
    const word = seg.split(/\s+/)[0] ?? '';
    // 跳过 cd：它不是被检查的程序
    if (/^cd$/i.test(word)) continue;
    return word.replace(/^["']|["']$/g, '');
  }
  return '';
}

/**
 * 判断一条验收命令在当前平台**语法上**能否执行。
 *
 * 只看命令本身，不读文件系统、不执行——所以很便宜，
 * 可以在派活前对每条 criteria 都跑一遍。
 */
export function checkCommandUsable(
  command: string,
  platform: NodeJS.Platform = process.platform,
): UsabilityResult {
  const cmd = command.trim();
  const program = firstProgramOf(cmd);

  if (!cmd) {
    return { usable: false, reason: '空命令', program: '' };
  }

  // POSIX 控制结构：for … do … done / if … then … fi / $VAR
  if (platform === 'win32') {
    if (/\bfor\b[^;]*\bdo\b|\bdone\b\s*$|\bif\b[\s\S]*\bfi\b/i.test(cmd)) {
      return {
        usable: false,
        reason: '含 POSIX shell 控制结构（for/do/done 或 if/fi），Windows cmd 不支持',
        program,
      };
    }
    if (/\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) {
      return {
        usable: false,
        reason: '使用 $VAR / $(...) 变量展开，Windows cmd 语法不同（应为 %VAR%）',
        program,
      };
    }
  }

  const lower = program.toLowerCase();

  if (CROSS_PLATFORM.has(lower)) {
    return { usable: true, program };
  }

  if (platform === 'win32' && POSIX_ONLY.has(lower)) {
    return {
      usable: false,
      reason: `「${program}」在 Windows 上不存在（这里没有 bash）。改用 findstr / if exist / node -e 等`,
      program,
    };
  }

  // 其余：不在黑名单也不在通用名单，交给运行时真跑一次才知道
  return { usable: true, program };
}

/**
 * 命令真的在当前 shell 里跑起来了吗？
 *
 * 用于**事后**判断：exec 失败时，是「程序不存在」还是「检查没过」。
 * 两者对用户的含义完全不同，不能混。
 */
export function looksLikeCommandNotFound(stderr: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!stderr) return false;
  if (platform === 'win32') {
    return (
      /is not recognized as an internal or external command/i.test(stderr) ||
      /不是内部或外部命令/.test(stderr) ||
      /operable program or batch file/i.test(stderr) ||
      /系统找不到指定的路径/.test(stderr)
    );
  }
  return /command not found|No such file or directory/i.test(stderr);
}

/**
 * 判断某个程序在本机是否真的存在（会起一个子进程，比静态判断准，但更贵）。
 *
 * 只在需要确认时调用——例如验收失败、想区分是环境问题还是逻辑问题。
 */
export function programExists(program: string): boolean {
  if (!program) return false;
  try {
    execSync(
      process.platform === 'win32' ? `where "${program}"` : `command -v "${program}"`,
      { stdio: 'ignore', windowsHide: true, timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** 给用户看的整体结论。 */
export interface UsabilityReport {
  readonly allUsable: boolean;
  readonly problems: readonly { readonly command: string; readonly reason: string }[];
}

/**
 * 检查一组验收命令。用于**派活前**统一校验。
 */
export function checkAllCommands(
  commands: readonly string[],
  platform: NodeJS.Platform = process.platform,
): UsabilityReport {
  const problems: { command: string; reason: string }[] = [];
  for (const cmd of commands) {
    const r = checkCommandUsable(cmd, platform);
    if (!r.usable) problems.push({ command: cmd, reason: r.reason ?? '不可用' });
  }
  return { allUsable: problems.length === 0, problems };
}
