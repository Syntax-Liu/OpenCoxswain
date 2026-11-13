/**
 * 沙箱测试。
 *
 * **这不是完整隔离，是命令级静态检查。** 所以测试要同时守住：
 * 1. 明显的越界写操作被拦住
 * 2. **查询类命令不被误杀**（读项目外是合理的）
 * 3. 已知的绕过方式如实记录（不假装挡住了）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkCommand,
  extractPathMentions,
  firstCommandWord,
  isInsideProject,
  isWriteCommand,
} from '../executor/sandbox.js';

const PROJECT = process.platform === 'win32' ? 'D:\\work\\app' : '/work/app';
const OUTSIDE = process.platform === 'win32' ? 'D:\\other\\file.txt' : '/other/file.txt';

describe('路径抽取', () => {
  it('抽出 Windows 盘符路径', () => {
    const mentions = extractPathMentions('copy src\\a.txt D:\\backup\\a.txt');
    assert.ok(mentions.some((m) => m.raw.startsWith('D:\\')));
  });

  it('抽出正斜杠的盘符路径', () => {
    const mentions = extractPathMentions('cp a.txt D:/backup/');
    assert.ok(mentions.some((m) => m.raw.startsWith('D:/')));
  });

  it('抽出 UNC 路径', () => {
    const mentions = extractPathMentions('copy a.txt \\\\server\\share\\a.txt');
    assert.ok(mentions.some((m) => m.kind === 'absolute' && m.raw.startsWith('\\\\')));
  });

  it('抽出上级引用', () => {
    const mentions = extractPathMentions('cd .. && rm -rf build');
    assert.ok(mentions.some((m) => m.kind === 'parent'));
  });

  it('相对路径不算越界引用', () => {
    assert.equal(extractPathMentions('node scripts/build.js').length, 0);
  });
});

describe('命令识别', () => {
  it('识别 Windows 写命令', () => {
    assert.equal(firstCommandWord('del a.txt'), 'del');
    assert.equal(firstCommandWord('robocopy a b'), 'robocopy');
  });

  it('识别 PowerShell 写命令', () => {
    assert.equal(firstCommandWord('Remove-Item -Recurse x'), 'remove-item');
  });

  it('识别 POSIX 写命令', () => {
    assert.equal(firstCommandWord('rm -rf dist'), 'rm');
  });

  it('剥掉 powershell -Command 包装', () => {
    assert.equal(firstCommandWord('powershell -NoProfile -Command "Remove-Item x"'), 'remove-item');
  });

  it('查询命令不算写', () => {
    assert.equal(isWriteCommand('dir'), false);
    assert.equal(isWriteCommand('Get-ChildItem'), false);
    assert.equal(isWriteCommand('pnpm test'), false);
  });

  it('**复合命令里任一段是写就算写**', () => {
    assert.equal(isWriteCommand('dir && del x.txt'), true);
    assert.equal(isWriteCommand('Get-ChildItem | Remove-Item'), true);
  });

  it('**shell 重定向也算写**（命令名只读但会写文件）', () => {
    assert.equal(isWriteCommand('echo hello > out.txt'), true);
    assert.equal(isWriteCommand('echo more >> out.txt'), true);
    assert.equal(isWriteCommand('type a.txt >| b.txt'), true);
  });

  it('句柄重定向不算写文件', () => {
    assert.equal(isWriteCommand('pnpm test 2>&1'), false);
  });

  it('**`2>&1 | 管道` 不算写**', () => {
    // `2>&1 |` 曾被 `>|` 规则误判成强制覆盖写，
    // 导致只读任务里跑 `pnpm test 2>&1 | head` 直接被拦掉。
    assert.equal(isWriteCommand('node --test x.js 2>&1 | head -30'), false);
    assert.equal(isWriteCommand('git log 2>&1 | findstr abc'), false);
  });

  it('**git 的读操作不算写**', () => {
    // 曾经把 'git' 整个列进写命令，只读任务连 `git status` 都做不了。
    assert.equal(isWriteCommand('git status'), false);
    assert.equal(isWriteCommand('git log --oneline'), false);
    assert.equal(isWriteCommand('git diff HEAD'), false);
  });

  it('**git 的写操作照样拦**', () => {
    assert.equal(isWriteCommand('git checkout main'), true);
    assert.equal(isWriteCommand('git reset --hard'), true);
    assert.equal(isWriteCommand('git clean -fd'), true);
    assert.equal(isWriteCommand('git push'), true);
    assert.equal(isWriteCommand('git commit -m x'), true);
  });
});

describe('项目内判断', () => {
  it('相对路径算项目内', () => {
    assert.equal(isInsideProject(PROJECT, 'src/a.ts'), true);
  });

  it('项目根内的绝对路径算项目内', () => {
    const inside = process.platform === 'win32' ? 'D:\\work\\app\\src\\a.ts' : '/work/app/src/a.ts';
    assert.equal(isInsideProject(PROJECT, inside), true);
  });

  it('**项目外的绝对路径算越界**', () => {
    assert.equal(isInsideProject(PROJECT, OUTSIDE), false);
  });

  it('前缀相似但不同目录不算项目内', () => {
    const sibling = process.platform === 'win32' ? 'D:\\work\\app2\\a.ts' : '/work/app2/a.ts';
    assert.equal(isInsideProject(PROJECT, sibling), false);
  });
});

describe('沙箱判定', () => {
  it('**写命令 + 项目外路径 → 拦住**', () => {
    const v = checkCommand(PROJECT, `copy a.txt ${OUTSIDE}`);
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? '', /项目外/);
    assert.ok((v.evidence ?? '').length > 0);
  });

  it('**写命令 + 跳到上级 → 拦住**', () => {
    const v = checkCommand(PROJECT, 'cd .. && rm -rf build');
    assert.equal(v.allowed, false);
    assert.match(v.reason ?? '', /跳出项目/);
  });

  it('项目内写命令放行', () => {
    const v = checkCommand(PROJECT, 'rm -rf dist');
    assert.equal(v.allowed, true);
  });

  it('**查询命令读项目外放行**（不该误杀）', () => {
    const v = checkCommand(PROJECT, `dir ${OUTSIDE}`);
    assert.equal(v.allowed, true);
  });

  it('普通的测试命令放行', () => {
    assert.equal(checkCommand(PROJECT, 'pnpm test').allowed, true);
    assert.equal(checkCommand(PROJECT, 'git status').allowed, true);
  });

  it('git 在项目内提交放行', () => {
    assert.equal(checkCommand(PROJECT, 'git add -A && git commit -m "x"').allowed, true);
  });

  it('**明确放行的项目外路径不拦**', () => {
    const v = checkCommand(PROJECT, `copy a.txt ${OUTSIDE}`, { allowOutside: [OUTSIDE] });
    assert.equal(v.allowed, true);
  });

  it('放行目录下的文件也放行', () => {
    const dir = process.platform === 'win32' ? 'D:\\other' : '/other';
    const file = process.platform === 'win32' ? 'D:\\other\\sub\\x.txt' : '/other/sub/x.txt';
    const v = checkCommand(PROJECT, `copy a.txt ${file}`, { allowOutside: [dir] });
    assert.equal(v.allowed, true);
  });
});

describe('已知挡不住的情况（如实记录）', () => {
  it('路径里**含变量拼接但字面量可见**时仍能拦住', () => {
    // 路径虽然写在变量里，但字面量出现在命令文本中，静态检查能抽到
    const v = checkCommand(PROJECT, 'powershell -Command "$p = \'D:\\other\'; Remove-Item $p"');
    assert.equal(v.allowed, false, '字面量可见就能拦');
  });

  it('**运行时才算出的路径挡不住**（静态检查的固有局限）', () => {
    // 路径由程序运行中拼出来，命令文本里没有任何项目外字面量。
    // 这类只能靠审批与只读档兜底——写在这里是为了让后来人知道边界。
    const v = checkCommand(PROJECT, 'node cleanup-script.js');
    assert.equal(v.allowed, true, '脚本内部做什么，静态检查看不到');

    const v2 = checkCommand(
      PROJECT,
      'powershell -Command "$p = (Get-ChildItem env:OUT_DIR).Value; Remove-Item $p"',
    );
    assert.equal(v2.allowed, true, '从环境变量取的路径也看不到');
  });

  it('**没有绝对路径的删除命令只能靠审批**', () => {
    const v = checkCommand(PROJECT, 'rm -rf .');
    assert.equal(v.allowed, true, '这是项目内删除，沙箱不管——靠审批');
  });
});
