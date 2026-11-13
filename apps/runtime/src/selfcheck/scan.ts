/**
 * 自检：发现"测试全绿但功能不工作"这类问题。
 *
 * ## 为什么需要
 *
 * 这一轮开发里有 6 个 bug 属于同一类：
 *
 * | bug | 测试为什么没抓到 |
 * | --- | --- |
 * | 快照传参漏了 `runExecutor` 那一环 | 测试覆盖了函数，没覆盖真实调用路径 |
 * | `edit_file` 没进台账 | 没测过"台账里有没有记录" |
 * | 管道吞掉退出码 | 没测过"命令带管道时的失败" |
 * | `git status` 被判成写操作 | 没测过"只读任务里跑 git" |
 * | `needsUser: !ok` 制造噪音 | 测了 `needsUser` 字段，没测"什么该标" |
 * | 侧栏批次位置错乱 | 测了函数，没测"倒序输入时" |
 *
 * 共同点：**测试都在测函数本身，没有测真实链路。**
 *
 * ## 这个模块做什么
 *
 * 静态扫描代码，找出这类风险点，**在写测试之前**就提示。
 * 不是替代测试，而是补上"测试容易漏什么"这个判断。
 */

export interface SelfCheckFinding {
  /** 问题类别。 */
  readonly kind: 'uncovered-wiring' | 'silent-swallow' | 'loose-optional';
  readonly severity: 'high' | 'medium' | 'low';
  readonly file: string;
  readonly line: number;
  /** **必须说明为什么这是问题**，不能只给位置。 */
  readonly why: string;
  /** 建议怎么补。 */
  readonly fix: string;
}

/** 一个源文件的内容。 */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * 找"配置项在多处构造、但有一处漏传"的风险。
 *
 * 快照那次：`createExecutorToolHost` 有两处传了 snapshots，
 * 但 `runExecutor` 内部又建了一个 tool host 没传——
 * 类型检查抓不到（都是可选字段），测试也抓不到（没走那条路径）。
 */
export function findUncoveredWiring(files: readonly SourceFile[]): SelfCheckFinding[] {
  const findings: SelfCheckFinding[] = [];

  for (const file of files) {
    const lines = file.text.split('\n');

    // 找"同一个可选字段在这个文件里被传递了不止一次"的情况
    /** key → 出现过的行号 */
    const optionalSpreads = new Map<string, number[]>();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // 形如 `...(options.foo ? { foo: options.foo } : {})`
      const m = /\.\.\.\(\s*(?:\w+)\.(\w+)\s*\?\s*\{\s*(\w+):/.exec(line);
      if (!m) continue;
      const key = m[2]!;
      const list = optionalSpreads.get(key) ?? [];
      list.push(i + 1);
      optionalSpreads.set(key, list);
    }

    for (const [key, positions] of optionalSpreads) {
      if (positions.length < 2) continue;
      // 出现多次本身不是问题（一个文件里多处构造 options 是正常的），
      // 问题是**有没有一处漏了**。这里只能提示人工确认。
      findings.push({
        kind: 'loose-optional',
        severity: 'low',
        file: file.path,
        line: positions[0]!,
        why:
          `可选字段 \`${key}\` 在本文件里被传递了 ${positions.length} 次` +
          `（行 ${positions.join(', ')}）——如果还存在别的构造点没传它，` +
          '类型检查不会报错，测试也可能覆盖不到。',
        fix: '确认所有构造这个 options 的地方都传了它；不确定就把它改成必填。',
      });
    }
  }

  return findings;
}

/**
 * 找"静默吞掉错误"的地方。
 *
 * `catch {}` 是最难查的一类：功能不工作时完全没有线索。
 * 这个项目里已经出现过——快照 save() 抛异常被 catch 吞了，
 * 表现是"撤销一直不生效"，查了六七轮才定位。
 */
export function findSilentSwallow(files: readonly SourceFile[]): SelfCheckFinding[] {
  const findings: SelfCheckFinding[] = [];

  for (const file of files) {
    const lines = file.text.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // catch { } 或 catch { /* 空 */ }，且后面没有记录
      if (!/\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*$/.test(line)) continue;

      // 看接下来几行是不是空的
      let body = '';
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
        const next = lines[j]!.trim();
        // **要 trim 后比**：真实代码里的闭合括号是带缩进的（`  }`），
        // 直接和 '}' 比会漏，导致把后面的语句也算进 catch 体。
        if (next === '}') break;
        body += next + ' ';
      }
      // **带注释的空 catch 不算**：注释是"明确说明为什么要忽略"，
      // 那正是我们想要的写法。只报完全没有说明的空 catch。
      const hasComment = /\/\*[\s\S]*?\*\/|\/\/.*/.test(body);
      if (hasComment) continue;
      if (body.trim() !== '') continue;

      findings.push({
        kind: 'silent-swallow',
        severity: 'medium',
        file: file.path,
        line: i + 1,
        why:
          '空 catch 吞掉了错误，而且没有写任何说明。功能不工作时**完全没有线索**——' +
          '这个项目曾因为快照保存抛异常被吞，查了六七轮才定位。',
        fix:
          '至少写一句注释说明为什么可以忽略；或者把原因记进结果的说明里。',
      });
    }
  }

  return findings;
}

/** 跑所有检查。 */
export function runSelfCheck(files: readonly SourceFile[]): SelfCheckFinding[] {
  return [...findUncoveredWiring(files), ...findSilentSwallow(files)].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });
}

/** 渲染成给人看的文本。 */
export function renderFindings(findings: readonly SelfCheckFinding[]): string {
  if (findings.length === 0) return '自检没有发现问题。';
  const lines = [`自检发现 ${findings.length} 处值得确认的地方`, ''];
  for (const f of findings) {
    lines.push(`${f.file}:${f.line}  [${f.severity}]`);
    lines.push(`  ${f.why}`);
    lines.push(`  → ${f.fix}`);
    lines.push('');
  }
  return lines.join('\n');
}
