/**
 * 验收命令的平台可执行性测试。
 *
 * 2026-11-15 实测踩到的坑：Assistant 在 Windows 上写 `test -f` / `grep -q`，
 * 而 cmd.exe 里没有这些命令。验收框架只认退出码，于是
 * 「命令不存在」被报成「检查没通过」——所有验收安静地变红。
 *
 * 这些用例锁住两条：
 *   1. 事前能识别跑不了的命令（checkCommandUsable）
 *   2. 事后能把「程序不存在」和「检查没过」分开（looksLikeCommandNotFound）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCommandUsable,
  checkAllCommands,
  firstProgramOf,
  looksLikeCommandNotFound,
} from '../acceptance/portability.js';

describe('firstProgramOf：取真正执行的程序', () => {
  it('普通命令', () => {
    assert.equal(firstProgramOf('pnpm -w typecheck'), 'pnpm');
  });

  it('跳过 cd 前缀', () => {
    assert.equal(firstProgramOf('cd apps/web && npx tsc --noEmit'), 'npx');
  });

  it('空命令', () => {
    assert.equal(firstProgramOf(''), '');
  });
});

describe('checkCommandUsable：Windows 上跑不了的命令', () => {
  it('**test -f 在 Windows 不可用**（实测踩过）', () => {
    const r = checkCommandUsable('test -f apps/web/src/a.ts', 'win32');
    assert.equal(r.usable, false);
    assert.match(r.reason ?? '', /test/);
    assert.match(r.reason ?? '', /Windows/);
  });

  it('**grep 在 Windows 不可用**（实测踩过）', () => {
    const r = checkCommandUsable("grep -q 'export function foo' a.ts", 'win32');
    assert.equal(r.usable, false);
  });

  it('POSIX 控制结构 for…do…done 不可用', () => {
    const r = checkCommandUsable('for s in a b c; do echo $s; done', 'win32');
    assert.equal(r.usable, false);
    assert.match(r.reason ?? '', /控制结构/);
  });

  it('$VAR 变量展开不可用', () => {
    const r = checkCommandUsable('echo $HOME', 'win32');
    assert.equal(r.usable, false);
    assert.match(r.reason ?? '', /\$VAR/);
  });

  it('同样这些命令在 Linux/macOS 上可用', () => {
    for (const cmd of [
      'test -f apps/web/src/a.ts',
      "grep -q 'foo' a.ts",
      'for s in a b; do echo $s; done',
    ]) {
      assert.equal(checkCommandUsable(cmd, 'linux').usable, true, cmd);
    }
  });
});

describe('checkCommandUsable：跨平台命令两个平台都可用', () => {
  const CROSS = [
    'pnpm -w typecheck',
    'git status --porcelain',
    'node --test',
    'npx tsc --noEmit',
    'npm test',
  ];

  for (const cmd of CROSS) {
    it(`${cmd} 在 win32 可用`, () => {
      assert.equal(checkCommandUsable(cmd, 'win32').usable, true);
    });
    it(`${cmd} 在 linux 可用`, () => {
      assert.equal(checkCommandUsable(cmd, 'linux').usable, true);
    });
  }
});

describe('checkCommandUsable：Windows 原生写法', () => {
  it('if exist 可用', () => {
    const r = checkCommandUsable('if exist apps\\web\\a.ts (exit 0) else (exit 1)', 'win32');
    assert.equal(r.usable, true);
  });

  it('findstr 可用', () => {
    assert.equal(checkCommandUsable('findstr /C:"laneStatusOf" a.ts', 'win32').usable, true);
  });

  it('**cmd 内建命令不能被误判**（踩过：把 echo 列进黑名单，打红两条验收测试）', () => {
    for (const cmd of ['echo hello', 'dir', 'mkdir out', 'copy a.txt b.txt', 'type a.txt']) {
      assert.equal(
        checkCommandUsable(cmd, 'win32').usable,
        true,
        `cmd 内建命令被误判为不可用：${cmd}`,
      );
    }
  });
});

describe('looksLikeCommandNotFound：事后区分两种失败', () => {
  it('**Windows 的「不是内部或外部命令」**（实测原文）', () => {
    const stderr =
      "'test' is not recognized as an internal or external command,\r\noperable program or batch file.";
    assert.equal(looksLikeCommandNotFound(stderr, 'win32'), true);
  });

  it('中文报错也认', () => {
    assert.equal(looksLikeCommandNotFound("'grep' 不是内部或外部命令", 'win32'), true);
  });

  it('POSIX 的 command not found', () => {
    assert.equal(looksLikeCommandNotFound('sh: 1: foo: command not found', 'linux'), true);
  });

  it('**普通的检查失败不算**（这是最重要的反例）', () => {
    // 测试真的没过 —— 不能误判成"命令不存在"，否则会把真实失败藏起来
    const cases = [
      'AssertionError: expected 1 to equal 2',
      'error TS2322: Type is not assignable',
      'Found 3 failing tests',
      '',
    ];
    for (const s of cases) {
      assert.equal(looksLikeCommandNotFound(s, 'win32'), false, `误判：${s}`);
      assert.equal(looksLikeCommandNotFound(s, 'linux'), false, `误判：${s}`);
    }
  });
});

describe('checkAllCommands：派活前统一校验', () => {
  it('全部可用', () => {
    const r = checkAllCommands(['pnpm -w typecheck', 'git status --porcelain'], 'win32');
    assert.equal(r.allUsable, true);
    assert.deepEqual(r.problems, []);
  });

  it('有不可用的就报出来', () => {
    const r = checkAllCommands(
      ['pnpm -w typecheck', 'test -f a.ts', "grep -q 'x' a.ts"],
      'win32',
    );
    assert.equal(r.allUsable, false);
    assert.equal(r.problems.length, 2);
  });
});
