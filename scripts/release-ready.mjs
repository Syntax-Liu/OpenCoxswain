#!/usr/bin/env node
/**
 * 发布前自检：**这一版到底能不能发**。
 *
 * 用法：
 *   node scripts/release-ready.mjs          只看结论
 *   node scripts/release-ready.mjs --json   机器可读
 *
 * 退出码 0 = 可以发，1 = 不能发。
 *
 * ## 为什么要有这个
 *
 * 之前"能不能发"是凭感觉的：测试全过就发。
 * 但测试全过不代表能发——这一轮有 6 个 bug 是"测试全绿但功能不工作"。
 *
 * 这个脚本把判据固化成代码，**不靠人记**。
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const json = process.argv.includes('--json');

const { evaluateRelease, renderVerdict } = await import(
  '../apps/runtime/dist/release/ready.js'
);

/** 跑一次测试，取通过/失败数。 */
async function runTests() {
  // Windows 上 pnpm 是 .cmd，必须经过 shell。
  // shell:true 会让 node 打 DEP0190 警告，用 NODE_OPTIONS 压掉，
  // 否则警告会混进 stdout 干扰下面解析。
  const options = {
    cwd: process.cwd(),
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  };
  try {
    const { stdout } = await exec('pnpm test', [], options);
    return summarize(stdout);
  } catch (error) {
    // 有测试失败时 pnpm 会非零退出，但输出还在
    return summarize(String(error.stdout ?? ''));
  }
}

/** 从 pnpm test 输出里抽通过/失败数。 */
function summarize(output) {
  let passed = 0;
  let failed = 0;
  // node:test 的汇总行： "ℹ pass 643" / "ℹ fail 0"
  for (const m of output.matchAll(/^ℹ (pass|fail) (\d+)$/gm)) {
    if (m[1] === 'pass') passed += Number(m[2]);
    else failed += Number(m[2]);
  }
  return { passed, failed };
}

/**
 * 本次改动相对上一个发布版本的文件列表。
 *
 * **用 git tag 找基准**，但如果 tag 太旧（维护断了），退化成
 * "最近一次提交"。否则会得出"改了 89 个源文件"这种荒谬结论。
 */
async function changedSinceLastRelease(current) {
  try {
    const { stdout: tagOut } = await exec('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: process.cwd(),
    });
    const tag = tagOut.trim();
    const tagVersion = tag.replace(/^v/, '');

    // tag 落后太多就不可信
    const [curMajor = 0, curMinor = 0] = current.split('.').map(Number);
    const [tagMajor = 0, tagMinor = 0] = tagVersion.split('.').map(Number);
    const drift = curMajor * 1000 + curMinor - (tagMajor * 1000 + tagMinor);

    if (drift <= 10) {
      const { stdout } = await exec('git', ['diff', '--name-only', `${tag}..HEAD`], {
        cwd: process.cwd(),
      });
      return { tag, files: stdout.split('\n').filter(Boolean) };
    }
  } catch {
    /* 没有 tag，走下面的退化路径 */
  }

  // 退化：只看最近一次提交
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', 'HEAD~1..HEAD'], {
      cwd: process.cwd(),
    });
    return { tag: null, files: stdout.split('\n').filter(Boolean) };
  } catch {
    return { tag: null, files: [] };
  }
}

/** 工作区是否干净。 */
async function isClean() {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: process.cwd() });
  return stdout.trim().length === 0;
}

/** 读当前版本号。 */
async function currentVersion() {
  const raw = await readFile(path.join(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

/**
 * 上一个**已发布**的版本。
 *
 * 用 git tag：这个仓库的版本 tag 已补齐（v0.15.0–v0.50.3 共 67 个），
 * tag 是"哪一版对应哪次提交"的唯一权威记录。
 *
 * **不能用 `HEAD~1`**：版本号常常在更早的提交里就 bump 了，
 * 拿上一次提交比会得出"版本号没变"的错误结论。
 * 也不能用 `latest.json`：发布流程里它会被重新生成成当前版本。
 *
 * 拿不到时返回 null，判据会明确说"无法确认"而不是默认通过。
 */
async function previousVersion() {
  try {
    // 列出所有版本 tag，按版本号倒序
    const { stdout } = await exec('git', ['tag', '--sort=-v:refname']);
    const tags = stdout
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

    // **如果当前版本已经有 tag，说明这一版发过了** —— 那不是"上一个版本"
    const current = await currentVersion();
    const withoutCurrent = tags.filter((t) => t !== `v${current}`);
    const latest = withoutCurrent[0];
    return latest ? latest.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** 本次新增的 TODO/FIXME。 */
async function newTodos(prevTag) {
  if (!prevTag) return 0;
  try {
    const { stdout } = await exec('git', ['diff', '--unified=0', `${prevTag}..HEAD`], {
      cwd: process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
    });
    let n = 0;
    for (const line of stdout.split('\n')) {
      // 只看新增行
      if (line.startsWith('+') && !line.startsWith('+++') && /\b(TODO|FIXME|XXX)\b/.test(line)) {
        n += 1;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** 当前版本是否已经发布过（有同名 tag）。 */
async function isAlreadyReleased(version) {
  try {
    const { stdout } = await exec('git', ['tag', '--list', `v${version}`]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---- 收集事实 ----

const tests = await runTests();
const version = await currentVersion();
const changed = await changedSinceLastRelease(version);
const prev = await previousVersion();

const facts = {
  tests,
  changedFiles: changed.files,
  changedTests: changed.files.filter((f) => /\.test\.tsx?$/.test(f)),
  hasUncommitted: !(await isClean()),
  version,
  previousVersion: prev,
  versionAlreadyReleased: await isAlreadyReleased(version),
  newTodos: await newTodos(changed.tag),
};

const verdict = evaluateRelease(facts);

/**
 * 工程健康检查：能发现"测试通过但构建会挂"的问题。
 *
 * 2026-11-13 归档 legacy 时踩过：typecheck 过、测试全过，
 * 但 `tauri build` 因为图标路径指向已归档目录而失败。
 * 那次发布卡了两个版本才修好——这类问题应该在发布前拦住。
 */
let healthOk = true;
let healthOutput = '';
try {
  healthOutput = execFileSync(
    process.execPath,
    [path.join(process.cwd(), 'scripts/health-check.mjs')],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
} catch (error) {
  healthOk = false;
  healthOutput = String(error.stdout ?? '');
}

if (json) {
  console.log(JSON.stringify({ facts, verdict, healthOk }, null, 2));
} else {
  console.log('\n发布前自检\n');
  console.log(renderVerdict(verdict));
  console.log('\n工程健康:');
  for (const line of healthOutput.trim().split('\n').slice(1)) console.log('  ' + line.trim());
  console.log('');
}

process.exit(verdict.ready && healthOk ? 0 : 1);
