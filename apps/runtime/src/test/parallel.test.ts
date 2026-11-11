/**
 * 只读任务的并行性测试。
 *
 * 背景（真实问题）：用户让 C「同时开三条只读任务」，结果被逐条执行。
 * C 自己在对话里报告："系统把没声明写域的只读任务也当成要串行了（它宁可保守）"。
 *
 * 根因：写域互斥只看"有没有声明写域"，把"只读"和"没声明"混为一谈。
 * 现在区分三种形态：readonly / 有写域 / 空写域（未声明）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Gate, parseScopeClaim, scopesConflict } from '../executor/gate.js';
import { detectMutatingCommand } from '../executor/executor.js';
import { judgeConflict } from '../assistant/session.js';

const ro = parseScopeClaim(['readonly']);
const rw = (scopes: string[]) => parseScopeClaim(scopes);

describe('parseScopeClaim', () => {
  it('["readonly"] 解析为只读', () => {
    const claim = parseScopeClaim(['readonly']);
    assert.equal(claim.access, 'readonly');
    assert.deepEqual(claim.scopes, []);
  });

  it('接受中文与简写', () => {
    assert.equal(parseScopeClaim(['只读']).access, 'readonly');
    assert.equal(parseScopeClaim(['ro']).access, 'readonly');
  });

  it('有路径时是读写', () => {
    const claim = parseScopeClaim(['src/auth']);
    assert.equal(claim.access, 'readwrite');
    assert.deepEqual(claim.scopes, ['src/auth']);
  });

  it('空数组是"未声明"的读写（最坏情况）', () => {
    const claim = parseScopeClaim([]);
    assert.equal(claim.access, 'readwrite');
    assert.deepEqual(claim.scopes, []);
  });
});

describe('只读任务不参与写域互斥（回归：曾逐条串行）', () => {
  it('两个只读任务之间不冲突', () => {
    assert.equal(scopesConflict(ro, ro), false);
  });

  it('只读与任何写任务都不冲突', () => {
    assert.equal(scopesConflict(ro, rw(['src/auth'])), false);
    assert.equal(scopesConflict(rw(['src/auth']), ro), false);
    assert.equal(scopesConflict(ro, rw([])), false, '只读 vs 未声明写域也不冲突');
  });

  it('闸门：三条只读任务同时准入，零排队', async () => {
    const gate = new Gate(5);
    await gate.acquire('a', ro);
    await gate.acquire('b', ro);
    await gate.acquire('c', ro);
    assert.deepEqual(gate.stats(), { running: 3, queued: 0, limit: 5 });
  });

  it('闸门：只读任务与正在跑的写任务并行', async () => {
    const gate = new Gate(5);
    await gate.acquire('writer', rw(['src/auth']));
    await gate.acquire('reader1', ro);
    await gate.acquire('reader2', ro);
    assert.equal(gate.stats().running, 3);
    assert.equal(gate.stats().queued, 0);
  });

  it('写任务仍受互斥保护（没被放松）', async () => {
    const gate = new Gate(5);
    await gate.acquire('w1', rw(['src/auth']));
    const pending = gate.acquire('w2', rw(['src/auth/login']));
    assert.equal(gate.stats().queued, 1);
    gate.release('w1');
    await pending;
    assert.equal(gate.stats().running, 1);
  });

  it('未声明写域的写任务仍与他人串行', async () => {
    const gate = new Gate(5);
    await gate.acquire('w1', rw(['src/auth']));
    void gate.acquire('w2', rw([]));
    assert.equal(gate.stats().queued, 1);
  });
});

describe('冲突判定对只读任务的处理', () => {
  const active = [
    { id: 'e1', label: '读任务1', writeScope: [], access: 'readonly' as const },
    { id: 'e2', label: '写任务', writeScope: ['src/auth'], access: 'readwrite' as const },
  ];

  it('只读任务一律判为可并行', () => {
    const result = judgeConflict({ claim: ro, active });
    assert.equal(result.judged, 'parallel');
    assert.match(result.reason, /只读/);
  });

  it('与只读任务不相交的写任务可并行', () => {
    const result = judgeConflict({ claim: rw(['src/export']), active });
    assert.equal(result.judged, 'parallel');
  });

  it('与写任务相交仍判为冲突', () => {
    const result = judgeConflict({ claim: rw(['src/auth/login']), active });
    assert.equal(result.judged, 'conflict');
  });
});

describe('只读任务的工具层硬拦截', () => {
  it('识别修改类命令', () => {
    for (const cmd of [
      'rm -rf src',
      'Remove-Item a.txt',
      'del a.txt',
      'New-Item -Path x.txt',
      'Set-Content a.txt "x"',
      'echo hi > a.txt',
      'git commit -m x',
      'npm install',
    ]) {
      assert.ok(detectMutatingCommand(cmd), `应当拦下：${cmd}`);
    }
  });

  it('放行纯查询命令', () => {
    for (const cmd of [
      'Get-ChildItem -Force',
      'dir /a',
      'git status --porcelain',
      'git log --oneline -5',
      'Test-Path a.txt',
      'Get-Content a.txt',
      'wc -l src/*.ts',
    ]) {
      assert.equal(detectMutatingCommand(cmd), null, `不该拦：${cmd}`);
    }
  });
});
