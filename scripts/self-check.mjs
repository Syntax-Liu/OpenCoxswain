#!/usr/bin/env node
/**
 * 自检：扫出"测试全绿但功能不工作"这类风险。
 *
 * 用法：
 *   node scripts/self-check.mjs           给人看
 *   node scripts/self-check.mjs --json    机器可读
 *
 * ## 这个脚本针对什么
 *
 * 这一轮开发里有 6 个 bug 属于同一类：**测试全绿，功能就是不工作**。
 * 共同原因是"测试都在测函数本身，没测真实链路"。
 *
 * 这个脚本做静态扫描，在写测试之前就提示风险点。
 * **不是替代测试**，是补上"测试容易漏什么"这个判断。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const { runSelfCheck } = await import('../apps/runtime/dist/selfcheck/scan.js');

const json = process.argv.includes('--json');

/** 递归收集源文件，跳过测试和产物目录。 */
async function collect(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['test', 'node_modules', 'dist', '.git'].includes(e.name)) continue;
      await collect(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push({ path: full.replace(/\\/g, '/'), text: await readFile(full, 'utf8') });
    }
  }
  return out;
}

const files = [
  ...(await collect('apps/runtime/src')),
  ...(await collect('apps/web/src')),
];

const findings = runSelfCheck(files);

if (json) {
  console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
} else {
  console.log(`\n自检：扫描 ${files.length} 个源文件\n`);
  if (findings.length === 0) {
    console.log('没有发现问题。\n');
  } else {
    const rank = { high: '高', medium: '中', low: '低' };
    for (const f of findings) {
      console.log(`${f.file}:${f.line}  [${rank[f.severity]}]`);
      console.log(`  ${f.why}`);
      console.log(`  → ${f.fix}`);
      console.log('');
    }
  }
}

// 只有 high（会导致功能静默失效的）才让退出码非 0，
// medium/low 是提示，不拦人。
process.exit(findings.some((f) => f.severity === 'high') ? 1 : 0);
