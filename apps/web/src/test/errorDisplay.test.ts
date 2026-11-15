/**
 * 错误分类测试。
 *
 * 核心约束：**分类要和 Agent 侧一致**。
 * 如果 Agent 以为能自己修、界面却让你去处理，用户会被无故打扰。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERROR_KIND_LABEL, classifyError } from '../components/errorDisplay.js';

describe('环境问题', () => {
  it('命令不存在', () => {
    const r = classifyError("'foo' 不是内部或外部命令");
    assert.equal(r.kind, 'environment');
    assert.equal(r.tone, 'danger');
  });

  it('文件不存在', () => {
    assert.equal(classifyError('ENOENT: no such file or directory').kind, 'environment');
  });

  it('端口占用', () => {
    assert.equal(classifyError('EADDRINUSE: port 47900 in use').kind, 'environment');
  });

  it('连不上', () => {
    assert.equal(classifyError('fetch failed: ECONNREFUSED').kind, 'environment');
  });

  it('**说明重试没用**（这是环境问题的特点）', () => {
    const r = classifyError('permission denied');
    assert.match(r.action, /重试没用|修一下/);
  });

  it('**目录不存在也归环境问题**（不是"需要你决定"）', () => {
    const r = classifyError('目录不存在或没有访问权限：Z:\\nope\\nope');
    assert.equal(r.kind, 'environment');
    assert.equal(r.tone, 'danger');
  });

  it('路径类问题的建议是针对路径的，不是泛泛的"修环境"', () => {
    const r = classifyError('目录不存在或没有访问权限：Z:\\nope');
    assert.match(r.title, /路径/);
    assert.match(r.action, /检查路径/);
  });

  it('不是目录也归环境问题', () => {
    assert.equal(classifyError('这不是一个目录：D:\\a.txt').kind, 'environment');
  });
});

describe('模型服务临时问题', () => {
  it('限流', () => {
    const r = classifyError('HTTP 429 rate limit exceeded');
    assert.equal(r.kind, 'self-recoverable');
  });

  it('超时', () => {
    assert.equal(classifyError('请求超时').kind, 'self-recoverable');
  });

  it('5xx', () => {
    assert.equal(classifyError('HTTP 503 overloaded').kind, 'self-recoverable');
  });

  it('**说明再发一次通常就好**', () => {
    const r = classifyError('timeout');
    assert.match(r.action, /再发一次/);
  });
});

describe('密钥问题', () => {
  it('未配置', () => {
    const r = classifyError('尚未配置模型密钥');
    assert.equal(r.kind, 'needs-user');
    assert.equal(r.tone, 'warn');
  });

  it('401', () => {
    assert.equal(classifyError('HTTP 401 Unauthorized').kind, 'needs-user');
  });

  it('**给出具体操作路径**（打开设置）', () => {
    const r = classifyError('invalid api key');
    assert.match(r.action, /设置/);
  });
});

describe('需要拍板', () => {
  it('等待批准', () => {
    const r = classifyError('危险动作未获批准，没有执行');
    assert.equal(r.kind, 'needs-user');
    assert.match(r.title, /等你/);
  });

  it('明确说需要你', () => {
    assert.equal(classifyError('这一步需要你决定用哪个方案').kind, 'needs-user');
  });
});

describe('默认与边界', () => {
  it('未知错误归到需要人看一眼', () => {
    const r = classifyError('奇怪的错误 XYZ-999');
    assert.equal(r.kind, 'needs-user');
  });

  it('空字符串不崩', () => {
    const r = classifyError('');
    assert.ok(r.title.length > 0);
  });

  it('**保留原始信息**（不能丢，排查要用）', () => {
    const original = 'HTTP 500: something specific went wrong at line 42';
    assert.equal(classifyError(original).detail, original);
  });

  it('三类都有标签', () => {
    for (const kind of ['self-recoverable', 'needs-user', 'environment'] as const) {
      assert.ok(ERROR_KIND_LABEL[kind].length > 0);
    }
  });
});
