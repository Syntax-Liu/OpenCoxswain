/**
 * 安装器必须清理 Windows 图标缓存。
 *
 * ## 为什么需要这条测试
 *
 * 用户实测：v0.104.0 换上了新图标，exe 里和窗口句柄上都是对的
 * （`SHGetFileInfo` / `WM_GETICON` 都返回紫色机器人），
 * **但任务栏一直显示旧的蓝色 "oc" 方块**。
 *
 * 直到手动删掉 `IconCache.db` + `iconcache_*.db` 并重启 explorer 才变。
 *
 * 这不是程序 bug，是 Windows 的缓存策略——但没有自动化的话，
 * **每次发版用户都得手工清一遍**，而用户不会知道要做这件事。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROOT = new URL('../../../shell/src-tauri/', import.meta.url);

const conf = JSON.parse(readFileSync(new URL('tauri.conf.json', ROOT), 'utf8')) as {
  bundle?: { windows?: { nsis?: { installerHooks?: string } } };
};

const hookPath = conf.bundle?.windows?.nsis?.installerHooks;

describe('**安装器注册了钩子**', () => {
  it('tauri.conf.json 里有 installerHooks', () => {
    assert.ok(hookPath, '没配 installerHooks，图标缓存不会自动清');
  });

  it('钩子文件存在', () => {
    assert.ok(hookPath);
    // 不存在会在这里抛，等于测试失败
    const src = readFileSync(new URL(hookPath, ROOT), 'utf8');
    assert.ok(src.length > 0, '钩子文件是空的');
  });
});

describe('**钩子会清图标缓存**', () => {
  const src = hookPath ? readFileSync(new URL(hookPath, ROOT), 'utf8') : '';

  it('用 NSIS_HOOK_POSTINSTALL（安装完成后执行）', () => {
    assert.match(src, /!macro NSIS_HOOK_POSTINSTALL/);
  });

  it('删 IconCache.db（旧格式缓存）', () => {
    assert.match(src, /IconCache\.db/);
  });

  it('删 iconcache_*.db（Win10/11 格式）', () => {
    assert.match(src, /iconcache_\*\.db/);
  });

  it('**重启 explorer**，否则缓存会被内存里的旧状态写回', () => {
    assert.match(src, /taskkill.*explorer\.exe/, '没结束 explorer');
    assert.match(src, /Exec.*explorer\.exe/, '没重启 explorer');
  });

  it('先杀 explorer 再删文件（顺序不能反）', () => {
    const kill = src.indexOf('taskkill');
    // 第二次删除发生在杀进程之后——这才是真正生效的那次
    const lastDelete = src.lastIndexOf('iconcache_*.db');
    assert.ok(kill > 0, '没杀 explorer');
    assert.ok(lastDelete > kill, '删文件必须在杀 explorer 之后');
  });
});
