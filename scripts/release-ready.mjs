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
 * 用 git tag：这个仓库的版本 tag 已经补齐（v0.15.0–v0.50.3 共 67 个），
 * tag 是"哪一版对应哪次提交"的唯一权威记录。
 *
 * 曾经不可靠是因为 tag 只到 v0.14.0（36 个版本走 GitHub Release 没打 tag）。
 * 已于 2026-11-13 从提交信息里批量补回，现在可信。
 *
 * 拿不到时返回 null，判据会明确说"无法确认"而不是默认通过。
 */
async function previousVersion() {
  try {
    // 排除当前 HEAD 上的 tag——那说明还没发新版
    const { stdout } = await exec('git', ['describe', '--tags', '--abbrev=0', 'HEAD~1'], {
      cwd: process.cwd(),
    });
    return stdout.trim().replace(/^v/, '');
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
