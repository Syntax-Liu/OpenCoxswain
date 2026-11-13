/**
 * 发布前的验收判据。
 *
 * ## 要解决的问题
 *
 * 现在"这一版能不能发"是**凭感觉**的：
 * 测试全过就发，但测试全过不代表能发——
 * 这一轮开发里就有 6 个 bug 是"测试全绿但功能不工作"。
 *
 * 半自动自进化要求：交付这一步要有**客观判据**，
 * 而不是"我看差不多可以了"。
 *
 * ## 判据从哪来
 *
 * 从这次踩过的坑反推。每一条都对应一个真实事故：
 *
 * | 判据 | 对应的事故 |
 * | --- | --- |
 * | 测试必须全过 | 基本要求 |
 * | 本次改动必须有对应测试 | 快照功能写了 9 个测试，但传参漏了——测试没覆盖真实调用路径 |
 * | 不能有未提交的改动 | 改一半发了，用户拿到的和仓库不一致 |
 * | 版本号必须变 | 忘了 bump，推送被拒 |
 * | 不能有 TODO/FIXME 新增 | 半成品不该发 |
 *
 * ## 一个原则：**宁可拦下，不要放行**
 *
 * 误拦一次，人多花五分钟看清楚；
 * 误放一次，用户拿到有问题的版本。
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ReleaseCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** **必须说清楚为什么**——只说 pass/fail 没有价值。 */
  readonly detail: string;
}

export interface ReleaseVerdict {
  readonly ready: boolean;
  /** 一句话结论，给用户看的。 */
  readonly summary: string;
  readonly checks: readonly ReleaseCheck[];
  /** 拦下的原因列表（只有 fail 的）。 */
  readonly blockers: readonly string[];
}

/** 一次发布前收集到的原始事实。 */
export interface ReleaseFacts {
  /** 测试统计。 */
  readonly tests: { readonly passed: number; readonly failed: number };
  /** 本次改动涉及的文件（相对路径）。 */
  readonly changedFiles: readonly string[];
  /** 本次改动的测试文件。 */
  readonly changedTests: readonly string[];
  /** 是否有未提交的改动。 */
  readonly hasUncommitted: boolean;
  /** 当前版本号。 */
  readonly version: string;
  /** 上一个已发布版本号（没有则为 null）。 */
  readonly previousVersion: string | null;
  /** 新增的 TODO/FIXME 数量。 */
  readonly newTodos: number;
}

/** 判断一个改动文件是否属于"需要测试的业务代码"。 */
export function needsTest(file: string): boolean {
  if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) return false;
  if (file.endsWith('.md')) return false;
  if (file.includes('/test/')) return false;
  if (file.endsWith('.css')) return false;
  if (file.endsWith('.json')) return false;
  // 只关心真正跑逻辑的源码
  return file.endsWith('.ts') || file.endsWith('.tsx');
}

/**
 * 按判据给出发布结论。
 *
 * **顺序无关**：所有检查都跑一遍，一次把所有问题列出来，
 * 而不是修一个报一个——那样要来回好几轮。
 */
export function evaluateRelease(facts: ReleaseFacts): ReleaseVerdict {
  const checks: ReleaseCheck[] = [];

  // ---- 1. 测试必须全过 ----
  //
  // **测试数为 0 要判失败**，不能判通过。
  // 真实踩过：命令没跑起来（找不到 pnpm），输出里一条测试汇总都没有，
  // 结果这个检查显示"✓ 0 个测试全过"——比不检查更糟。
  const total = facts.tests.passed + facts.tests.failed;
  checks.push({
    id: 'tests',
    label: '测试全过',
    status: facts.tests.failed > 0 || total === 0 ? 'fail' : 'pass',
    detail:
      total === 0
        ? '没有跑出任何测试结果——测试命令可能失败了，不能当通过'
        : facts.tests.failed > 0
          ? `${facts.tests.failed} 个测试失败（共 ${total}）`
          : `${facts.tests.passed} 个测试全过`,
  });

  // ---- 2. 改了业务代码就要有对应测试 ----
  //
  // 这条针对的是"快照功能 9 个测试全过、但传参漏了"那次事故：
  // 测试覆盖了函数，没覆盖真实调用路径。
  const sourceFiles = facts.changedFiles.filter(needsTest);
  const hasTestChange = facts.changedTests.length > 0;
  checks.push({
    id: 'tested',
    label: '改动有测试',
    status: sourceFiles.length > 0 && !hasTestChange ? 'fail' : 'pass',
    detail:
      sourceFiles.length === 0
        ? '这次没有改业务代码'
        : hasTestChange
          ? `改了 ${sourceFiles.length} 个源文件，同时改了 ${facts.changedTests.length} 个测试`
          : `改了 ${sourceFiles.length} 个源文件，但**没有改任何测试**`,
  });

  // ---- 3. 不能带着未提交的改动发布 ----
  checks.push({
    id: 'clean',
    label: '工作区干净',
    status: facts.hasUncommitted ? 'fail' : 'pass',
    detail: facts.hasUncommitted
      ? '有未提交的改动——发出去的版本会和仓库对不上'
      : '没有未提交的改动',
  });

  // ---- 4. 版本号必须变 ----
  //
  // **拿不到上一个版本时判 warn，不是 pass**。
  // 判 pass 等于"没检查也放行"，比不检查更糟——
  // 用户会以为检查过了。
  const versionChanged = facts.previousVersion !== null && facts.version !== facts.previousVersion;
  checks.push({
    id: 'version',
    label: '版本号已更新',
    status:
      facts.previousVersion === null ? 'warn' : versionChanged ? 'pass' : 'fail',
    detail:
      facts.previousVersion === null
        ? `查不到上一个发布版本，无法确认 ${facts.version} 是新版本——发之前自己确认一下`
        : versionChanged
          ? `${facts.previousVersion} → ${facts.version}`
          : `版本号还是 ${facts.version}，没有更新`,
  });

  // ---- 5. 不新增 TODO/FIXME ----
  checks.push({
    id: 'todos',
    label: '没有新增半成品标记',
    status: facts.newTodos > 0 ? 'warn' : 'pass',
    detail:
      facts.newTodos > 0
        ? `本次新增了 ${facts.newTodos} 处 TODO/FIXME——确认它们不是半成品`
        : '没有新增 TODO/FIXME',
  });

  const blockers = checks.filter((c) => c.status === 'fail').map((c) => c.detail);
  const ready = blockers.length === 0;
  const warnings = checks.filter((c) => c.status === 'warn').length;

  return {
    ready,
    summary: ready
      ? warnings > 0
        ? `可以发布（有 ${warnings} 项提醒）`
        : '可以发布'
      : `不能发布：${blockers.length} 项未通过`,
    checks,
    blockers,
  };
}

/** 渲染成给人看的多行文本。 */
export function renderVerdict(verdict: ReleaseVerdict): string {
  const icon: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };
  const lines = [verdict.summary, ''];
  for (const c of verdict.checks) {
    lines.push(`${icon[c.status]} ${c.label}`);
    lines.push(`    ${c.detail}`);
  }
  return lines.join('\n');
}
