/**
 * 端到端验证：Windows 上跑不了的验收命令，现在会被正确判为 unverified，
 * 而不是 failed。
 *
 * 直接调 verify()，绕过整个运行时，最直接。
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../apps/runtime/dist/acceptance/verify.js';

const root = await mkdtemp(join(tmpdir(), 'ocx-portability-'));

// 造一个真实存在的文件，用来证明「文件明明在，旧逻辑会判失败」
await writeFile(join(root, 'exists.ts'), 'export const x = 1;\n');

const allowAll = async () => ({ approved: true });

const cases = [
  {
    name: '正常命令（应 passed）',
    check: 'echo hello',
  },
  {
    name: 'POSIX test -f，文件确实存在（旧逻辑会判 failed）',
    check: 'test -f exists.ts',
  },
  {
    name: 'POSIX grep，内容确实存在（旧逻辑会判 failed）',
    check: "grep -q 'export const' exists.ts",
  },
  {
    name: '检查真的没过（应仍判 failed）',
    check: 'node -e "process.exit(1)"',
  },
];

console.log('验收命令判定（平台：' + process.platform + '）\n');

let pass = 0;
let fail = 0;

for (const c of cases) {
  const r = await verify({
    rootPath: root,
    criteria: [{ id: 'c', desc: c.name, type: 'command', check: c.check }],
    policy: 'unverified_only',
    approve: allowAll,
  });
  const verdict = r.results[0]?.verdict;
  const note = r.results[0]?.note ?? '';

  // 期望：POSIX 命令 → unverified；正常命令 → passed；真失败 → failed
  const expect =
    c.name.includes('POSIX') ? 'unverified' : c.name.includes('真的没过') ? 'failed' : 'passed';
  const ok = verdict === expect;
  ok ? (pass += 1) : (fail += 1);

  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`   判定=${verdict}（期望 ${expect}）`);
  console.log(`   说明=${note.slice(0, 90)}`);
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
