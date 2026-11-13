/**
 * 命令沙箱：把命令的破坏范围限制在项目目录内。
 *
 * ## 已有的三道防线，为什么还需要第四道
 *
 * | 防线 | 挡什么 | 漏什么 |
 * | --- | --- | --- |
 * | 只读拦截 | 只读任务里的写命令 | 不适用于读写任务 |
 * | 写域闸门 | 改错目录 | 只作用于**工具**，不管 shell 命令 |
 * | 危险动作审批 | 删/推/发布/付款/外发 | **只认关键词**，绕得过 |
 *
 * 审批是"事后问一句"，沙箱是"根本做不到"。
 * 一条 `robocopy` 或 `Remove-Item -Recurse D:\` 只要没命中关键词就真会执行。
 *
 * ## 这个实现的能力边界（必须诚实）
 *
 * **它不是真正的进程隔离。** 真正的沙箱要用操作系统能力
 * （Windows AppContainer、Job Object + ACL、Linux namespace/seccomp），
 * 那需要原生模块，会破坏"零依赖"。
 *
 * 这里做的是**命令级静态检查**：在执行前分析命令文本，拦住明显越界的写操作。
 *
 * | 能挡 | 挡不住 |
 * | --- | --- |
 * | 显式引用项目外的绝对路径 | 变量拼接出的路径（`$p = "D:\"`） |
 * | `cd ..` 后操作上级目录 | 脚本内部自己算出的路径 |
 * | 常见删除/移动命令作用于项目外 | 恶意构造的混淆写法 |
 *
 * **所以沙箱是"纵深防御"的一层，不是唯一防线。**
 * 真正的保证仍然来自：审批 + 只读档 + 事后可查的台账。
 *
 * ## 什么时候启用
 *
 * 默认启用。它是**收紧**而不是放松，所以不需要用户额外授权。
 * 误杀可通过 `allowOutside` 放行（比如明确要操作的项目外目录）。
 */
import path from 'node:path';

/** 一次检查的结论。 */
export interface SandboxVerdict {
  readonly allowed: boolean;
  /** 拒绝原因（给人话）。 */
  readonly reason?: string;
  /** 命中的具体证据。 */
  readonly evidence?: string;
}

/**
 * 会写文件系统的命令（shell 内置 + 常见工具）。
 *
 * 只列**写类**命令——查询类命令不检查，避免误杀。
 */
const WRITE_COMMANDS = new Set([
  // Windows cmd
  'del', 'erase', 'rmdir', 'rd', 'md', 'mkdir', 'move', 'ren', 'rename',
  'copy', 'xcopy', 'robocopy', 'mklink', 'attrib', 'icacls', 'takeown',
  'format', 'diskpart', 'reg', 'sc', 'schtasks',
  // PowerShell
  'remove-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir',
  'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac',
  'copy-item', 'cp', 'cpi', 'move-item', 'mv', 'mi',
  'out-file', 'set-location', 'cd', 'push-location',
  'clear-content', 'clc', 'rename-item', 'rni',
  // POSIX
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown',
  'ln', 'dd', 'truncate', 'shred', 'tee',
  // 版本控制里会改工作区的
  // 版本控制：**不能整个把 git 列进来**。git status / log / diff 都是纯读，
  // 只读任务里最常用的恰恰是它们。会改工作区的子命令在 isWriteCommand 里单独判。
]);

/** 看起来就像项目外的路径（绝对路径 / 盘符 / 上级引用）。 */
interface PathMention {
  readonly raw: string;
  readonly kind: 'absolute' | 'parent';
}

/**
 * 从命令里粗抽出可能的路径参数。
 *
 * 不追求完美的解析——只要能把「明显指向项目外的绝对路径」抓出来就够。
 */
export function extractPathMentions(command: string): PathMention[] {
  const out: PathMention[] = [];

  // Windows 盘符路径：D:\xxx 或 D:/xxx
  for (const m of command.matchAll(/\b([A-Za-z]:[\\/][^\s"';|&)]*)/g)) {
    out.push({ raw: m[1]!, kind: 'absolute' });
  }

  // UNC 路径：\\server\share
  for (const m of command.matchAll(/(\\\\[^\s"';|&)]+)/g)) {
    out.push({ raw: m[1]!, kind: 'absolute' });
  }

  // 明显的上级引用：cd ..、cd ../..、路径里出现 ../
  for (const m of command.matchAll(/(?:^|\s|")(\.\.[\\/][^\s"';|&)]*)/g)) {
    out.push({ raw: m[1]!, kind: 'parent' });
  }
  if (/(?:^|\s|;|&|\|)cd\s+\.\.(?:\s|$|;|&|\|)/i.test(command)) {
    out.push({ raw: 'cd ..', kind: 'parent' });
  }

  return out;
}

/** 取出命令的第一个词（判断是不是写类命令）。 */
export function firstCommandWord(command: string): string | null {
  // 去掉前导的引号、括号、以及 powershell -Command 这类包装
  const cleaned = command
    .replace(/^\s*(?:powershell(?:\.exe)?|pwsh|cmd(?:\.exe)?)\s+[^&|;]*-c(?:ommand)?\s+/i, '')
    .replace(/^[\s("']+/, '')
    .trim();

  const match = /^([A-Za-z_][A-Za-z0-9_.-]*)/.exec(cleaned);
  return match ? match[1]!.toLowerCase() : null;
}

/** 命令里是否含写类操作。 */
export function isWriteCommand(command: string): boolean {
  // **shell 重定向也是写**：`echo x > file` 的命令名是 echo（只读命令），
  // 但 `>` 会把内容写进文件。只看命令名会漏掉这一大类。
  //
  // 匹配 `>`、`>>`、`>|`，但排除 `2>&1` 这种句柄复制：
  // 那种是 `>&` 后面跟数字，不是写文件。
  if (/(?<![0-9])>{1,2}(?!&|>)/.test(command)) return true;
  // `>|` 是强制覆盖写；但 `2>&1 | head` 里的 `>|` 是"复制句柄 + 管道"，**不是写**。
  // 只认前面既不是 `&` 也不是数字的 `>|`。
  // 这个 bug 曾让 `pnpm test 2>&1 | head` 被当成写操作直接拦掉。
  if (/(?<![&0-9])>\|/.test(command)) return true;

  // git 子命令分开看：status/log/diff 是读，checkout/reset 是写。
  // 把 git 整个当写命令，会让只读任务连 `git status` 都做不了。
  if (
    /\bgit\s+(?:checkout|reset|clean|restore|stash|merge|rebase|pull|fetch|commit|push|add|rm|mv|apply|cherry-pick|revert|switch|init|clone)\b/i.test(
      command,
    )
  ) {
    return true;
  }

  // 逐个分句检查：`a && b` 里 b 是写命令也要算
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const word = firstCommandWord(segment);
    if (!word) continue;
    if (WRITE_COMMANDS.has(word)) return true;
  }
  return false;
}

/** 判断一个路径是否落在项目内。 */
export function isInsideProject(projectRoot: string, raw: string): boolean {
  const root = path.resolve(projectRoot);
  // 相对路径一律视为项目内（它们相对 cwd，而 cwd 就是项目根）
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 检查一条命令能否执行。
 *
 * **只拦「写命令 + 明确的项目外路径」这一组合**——
 * 查询类命令读项目外（比如 `dir D:\logs`）是合理的，不该拦。
 */
export function checkCommand(
  projectRoot: string,
  command: string,
  options: { readonly allowOutside?: readonly string[] } = {},
): SandboxVerdict {
  const allowedOutside = options.allowOutside ?? [];
  const mentions = extractPathMentions(command);

  // 先看有没有被显式放行的路径
  const outside = mentions.filter((m) => {
    if (m.kind === 'parent') return false; // 上级引用单独判断
    if (isInsideProject(projectRoot, m.raw)) return false;
    return !allowedOutside.some((a) => isInsideProject(a, m.raw) || a === m.raw);
  });

  // 只有在"写命令"时，项目外路径才算问题
  if (outside.length > 0 && isWriteCommand(command)) {
    return {
      allowed: false,
      reason:
        '命令会对项目外的路径做写操作，已被沙箱拦住。\n' +
        'Agent 只能改本项目目录内的文件——这是防止误删的重要手段。\n' +
        '如果确实需要操作项目外（比如清理临时文件），请说明后由用户来做。',
      evidence: outside.map((m) => m.raw).slice(0, 3).join(', '),
    };
  }

  // 写命令 + 显式跳到上级目录
  const parents = mentions.filter((m) => m.kind === 'parent');
  if (parents.length > 0 && isWriteCommand(command)) {
    return {
      allowed: false,
      reason:
        '命令会跳出项目目录做写操作，已被沙箱拦住。\n' +
        '写操作必须留在项目目录内。',
      evidence: parents.map((m) => m.raw).slice(0, 3).join(', '),
    };
  }

  return { allowed: true };
}
