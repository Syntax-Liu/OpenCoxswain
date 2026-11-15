/**
 * 文件卡片测试。
 *
 * 重点是 `extractPath`：实测发现 `fs.delete` 的 target 存的是**整条命令**，
 * 直接显示会变成 "FILEbuild-probe\" 这种乱码。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPath, fileBadge, splitPath, actionVerb } from '../components/FileCard.js';
import type { SideEffectDto } from '../api.js';

const effect = (over: Partial<SideEffectDto> = {}): SideEffectDto => ({
  id: 'e1',
  projectId: 'p',
  executorId: 'x',
  kind: 'fs.write',
  target: 'src/a.ts',
  state: 'succeeded',
  reversible: true,
  tool: 'edit_file',
  args: '{}',
  note: null,
  createdAt: 0,
  settledAt: 1,
  ...over,
});

describe('extractPath：fs.write 直接用 target', () => {
  it('普通路径', () => {
    assert.equal(extractPath('apps/web/src/a.ts', 'fs.write'), 'apps/web/src/a.ts');
  });

  it('Windows 反斜杠路径', () => {
    assert.equal(extractPath('apps\\web\\src\\a.ts', 'fs.write'), 'apps\\web\\src\\a.ts');
  });

  it('完全不是路径的返回 null', () => {
    assert.equal(extractPath('hello', 'fs.write'), null);
  });
});

describe('extractPath：fs.delete 从命令行里抠路径', () => {
  it('**实测原文**：del /q "路径" & echo EXITCODE', () => {
    const cmd = 'del /q "D:\\Users\\x\\docs\\e2e-approval-test.txt" & echo EXITCODE=%ERRORLEVEL%';
    assert.equal(extractPath(cmd, 'fs.delete'), 'D:\\Users\\x\\docs\\e2e-approval-test.txt');
  });

  it('**实测原文**：cmd /c "rmdir /s /q 路径"', () => {
    const cmd = 'cmd /c "rmdir /s /q apps\\web\\dist-test\\build-probe"';
    assert.equal(extractPath(cmd, 'fs.delete'), 'apps\\web\\dist-test\\build-probe');
  });

  it('不带引号的 del', () => {
    assert.equal(extractPath('del apps\\old.txt', 'fs.delete'), 'apps\\old.txt');
  });

  it('不是文件操作的命令返回 null（不显示假卡片）', () => {
    for (const cmd of [
      'cmd /c "cd apps\\web && .\\node_modules\\.bin\\vite.cmd build"',
      'powershell -NoProfile -Command "Get-ChildItem"',
      'node --test',
    ]) {
      assert.equal(extractPath(cmd, 'fs.delete'), null, `不该提取出路径：${cmd}`);
    }
  });
});

describe('splitPath / fileBadge', () => {
  it('拆出文件名与目录', () => {
    assert.deepEqual(splitPath('apps/web/src/a.ts'), { name: 'a.ts', dir: 'apps/web/src' });
  });

  it('反斜杠也认', () => {
    assert.deepEqual(splitPath('apps\\web\\a.ts'), { name: 'a.ts', dir: 'apps/web' });
  });

  it('没有目录', () => {
    assert.deepEqual(splitPath('a.ts'), { name: 'a.ts', dir: '' });
  });

  it('按扩展名给标签', () => {
    assert.equal(fileBadge('a.tsx'), 'TSX');
    assert.equal(fileBadge('a.md'), 'MD');
    assert.equal(fileBadge('a.json'), 'JSON');
    assert.equal(fileBadge('README'), 'FILE');
  });
});

describe('actionVerb', () => {
  it('删除', () => {
    assert.equal(actionVerb(effect({ kind: 'fs.delete' })), '删除');
  });

  it('note 里提到新建 → 创建', () => {
    assert.equal(actionVerb(effect({ note: 'created new file' })), '创建');
  });

  it('其他一律说修改（不瞎猜）', () => {
    assert.equal(actionVerb(effect()), '修改');
  });
});
