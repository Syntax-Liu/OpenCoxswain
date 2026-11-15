/**
 * 侧边栏浏览器地址规整测试。
 *
 * 重点在安全：只放行 http/https。
 * `javascript:` 这类伪协议如果被塞进 iframe 的 src，等于在本页面执行代码。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../components/Sidebar.js';

describe('normalizeUrl：补协议', () => {
  it('没有协议时补 http://', () => {
    assert.equal(normalizeUrl('localhost:5173'), 'http://localhost:5173/');
  });

  it('已有 http 不变', () => {
    assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000/');
  });

  it('https 保留', () => {
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  });

  it('保留路径与查询', () => {
    assert.equal(
      normalizeUrl('localhost:5173/app?x=1'),
      'http://localhost:5173/app?x=1',
    );
  });
});

describe('normalizeUrl：**只放行 http/https**', () => {
  it('javascript: 被拒', () => {
    assert.equal(normalizeUrl('javascript:alert(1)'), null);
  });

  it('data: 被拒', () => {
    assert.equal(normalizeUrl('data:text/html,<script>alert(1)</script>'), null);
  });

  it('file: 被拒', () => {
    assert.equal(normalizeUrl('file:///C:/Windows/System32/'), null);
  });

  it('vbscript: 被拒', () => {
    assert.equal(normalizeUrl('vbscript:msgbox(1)'), null);
  });

  it('空串被拒', () => {
    assert.equal(normalizeUrl(''), null);
    assert.equal(normalizeUrl('   '), null);
  });
});
