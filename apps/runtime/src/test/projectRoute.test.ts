/**
 * 项目子路由的解析测试。
 *
 * 实测 2026-11-15：`/api/projects/:id/memory-list` 一直 404。
 * 原因是路由正则的 action 段写的是 `[a-z]+`，匹配不了连字符，
 * 整个 URL 不匹配，直接落进 404 分支。
 *
 * 这类「路由静默失效」既不报错也不打日志，只有真的调接口才会发现。
 * 这里把正则的行为单独锁住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** 与 server.ts 中一致的匹配规则。 */
const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)(?:\/([a-z][a-z0-9-]*))?$/;

function parse(pathname: string): { id: string; action?: string } | null {
  const m = PROJECT_ROUTE.exec(pathname);
  if (!m) return null;
  return {
    id: decodeURIComponent(m[1]!),
    ...(m[2] ? { action: m[2] } : {}),
  };
}

describe('项目子路由解析', () => {
  it('不带 action', () => {
    assert.deepEqual(parse('/api/projects/prj_1'), { id: 'prj_1' });
  });

  it('简单 action', () => {
    assert.deepEqual(parse('/api/projects/prj_1/messages'), {
      id: 'prj_1',
      action: 'messages',
    });
  });

  it('**带连字符的 action**（曾经会 404）', () => {
    assert.deepEqual(parse('/api/projects/prj_1/memory-list'), {
      id: 'prj_1',
      action: 'memory-list',
    });
  });

  it('带数字的 action', () => {
    assert.deepEqual(parse('/api/projects/prj_1/v2-report'), {
      id: 'prj_1',
      action: 'v2-report',
    });
  });

  it('多级路径不匹配（交给别的分支处理）', () => {
    assert.equal(parse('/api/projects/prj_1/memory/global/mem_1/forget'), null);
  });

  it('空 action 不匹配', () => {
    assert.equal(parse('/api/projects/prj_1/'), null);
  });

  it('大写开头的 action 不匹配（约定用小写）', () => {
    assert.equal(parse('/api/projects/prj_1/Messages'), null);
  });

  it('项目 id 里的中文能正确解码', () => {
    assert.deepEqual(parse('/api/projects/%E4%B8%AD%E6%96%87/messages'), {
      id: '中文',
      action: 'messages',
    });
  });
});
