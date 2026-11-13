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
import { execFile } from 'node:child_process';
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
  try {
    // 用 --test-reporter 让输出稳定，只关心汇总
    const { stdout } = await exec('pnpm', ['test'], {
      cwd: process.cwd(),
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
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
 * 上一个发布版本。
 *
 * **以 `latest.json` 为准**，不用 git tag：
 * 这个仓库有 36 个版本是通过 GitHub Release 发的、没打 tag，
 * 只读 tag 会得到 0.14.0 这种严重过时的答案。
 *
 * latest.json 是发布脚本生成的，反映**真正发出去的最后那一版**。
 */
async function previousVersion() {
  try {
    const raw = await readFile(
      path.join(
        process.cwd(),
        'apps/shell/src-tauri/target/release/bundle/nsis/latest.json',
      ),
      'utf8',
    );
    return JSON.parse(raw).version ?? null;
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
  newTodos: await newTodos(changed.tag),
};

const verdict = evaluateRelease(facts);

if (json) {
  console.log(JSON.stringify({ facts, verdict }, null, 2));
} else {
  console.log('\n发布前自检\n');
  console.log(renderVerdict(verdict));
  console.log('');
}

process.exit(verdict.ready ? 0 : 1);
