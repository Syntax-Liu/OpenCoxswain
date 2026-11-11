/**
 * 边界守护测试。
 *
 * 这个文件的作用不是测功能，而是**守住架构边界**：
 *
 * 1. 能力接口层不许 import 任何具体实现（否则核心永远换不掉实现）；
 * 2. 运行时继续零第三方依赖（否则"自研、不寄生"就成了空话）；
 * 3. 不依赖 DeepSeek Harness 的任何包（这是用户的硬性要求）。
 *
 * 这些断言看起来"太严格"，但正是它们让"将来能换成插件"这件事成立。
 * 一旦有人图省事在 capabilities 里 import 了具体实现，
 * 这条测试会立刻失败并说明原因。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/test → dist → src */
const srcRoot = path.resolve(here, '..', '..', 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 取一个文件里所有的 import 说明符。 */
function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

describe('能力边界', () => {
  it('capabilities 层只允许 import 类型，不许碰具体实现', async () => {
    const dir = path.join(srcRoot, 'capabilities');
    const files = await sourceFiles(dir);
    assert.ok(files.length > 0, '应当有能力接口文件');

    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const spec of importSpecifiers(code)) {
        // 只允许别的能力模块之间互相引用。
        assert.ok(
          spec.startsWith('.') && !spec.startsWith('../'),
          `${path.relative(srcRoot, file)} 不应 import 外部包：${spec}`,
        );
      }
    }
  });

  it('**运行时零第三方依赖**（自研的底线）', async () => {
    const pkg = JSON.parse(
      await readFile(path.resolve(srcRoot, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.deepEqual(
      deps,
      [],
      `运行时不允许第三方依赖，却发现了：${deps.join(', ')}`,
    );
  });

  it('**不依赖 DeepSeek Harness 的任何包**（用户的硬性要求）', async () => {
    const files = await sourceFiles(srcRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const spec of importSpecifiers(code)) {
        if (/dsh|cordis|deepseek-harness/i.test(spec)) {
          offenders.push(`${path.relative(srcRoot, file)} → ${spec}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `检测到对 DSH 的依赖，这会让项目变成它的插件：\n${offenders.join('\n')}`,
    );
  });

  it('核心模块不直接 import 能力的具体实现路径（应通过注入）', async () => {
    // Orchestrator 可以 import 具体实现来做默认装配，
    // 但不允许在 capabilities/ 里这么做——上面第一条已经守住。
    // 这里额外确认接口文件里没有任何值导入（只有 type 导入）。
    const indexFile = path.join(srcRoot, 'capabilities', 'index.ts');
    const code = await readFile(indexFile, 'utf8');
    const valueImports = [...code.matchAll(/^import\s+(?!type)[^;]+;/gm)];
    assert.equal(
      valueImports.length,
      0,
      '能力接口层不应有值导入（必须是纯类型层）',
    );
  });
});
