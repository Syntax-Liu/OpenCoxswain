/**
 * 桌面外观相关测试。
 *
 * 覆盖：首屏注入的窗口控制令牌、以及"没有壳时不显示桌面按钮"的判断依据。
 *
 * **窗口控制本身（最小化/最大化/关闭）需要真实窗口，这里不假装测过**——
 * 验证方法是打包后点按钮看效果，已在提交说明里写明。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { injectToken } from '../server/server.js';

describe('首屏注入', () => {
  it('注入访问令牌', () => {
    const html = injectToken('<html><head></head><body></body></html>', 'tok123');
    assert.match(html, /window\.__OCX_TOKEN__="tok123"/);
  });

  it('**桌面壳环境下同时注入窗口控制令牌**', () => {
    const saved = process.env.OPENCOXSWAIN_SECRET_TOKEN;
    process.env.OPENCOXSWAIN_SECRET_TOKEN = 'secret-abc';
    try {
      const html = injectToken('<head></head>', 'tok');
      assert.match(html, /window\.__OCX_SECRET_TOKEN__="secret-abc"/);
    } finally {
      if (saved === undefined) delete process.env.OPENCOXSWAIN_SECRET_TOKEN;
      else process.env.OPENCOXSWAIN_SECRET_TOKEN = saved;
    }
  });

  it('**没有壳时窗口令牌注入为 null**（普通浏览器里不显示窗口按钮）', () => {
    const saved = process.env.OPENCOXSWAIN_SECRET_TOKEN;
    delete process.env.OPENCOXSWAIN_SECRET_TOKEN;
    try {
      const html = injectToken('<head></head>', 'tok');
      assert.match(html, /window\.__OCX_SECRET_TOKEN__=null/);
    } finally {
      if (saved !== undefined) process.env.OPENCOXSWAIN_SECRET_TOKEN = saved;
    }
  });

  it('两个令牌都不含可执行标签（XSS 防护）', () => {
    const saved = process.env.OPENCOXSWAIN_SECRET_TOKEN;
    process.env.OPENCOXSWAIN_SECRET_TOKEN = '</script><img src=x>';
    try {
      const html = injectToken('<head></head>', '</script>');
      assert.ok(!html.includes('</script><img'), '不该出现可执行标签');
    } finally {
      if (saved === undefined) delete process.env.OPENCOXSWAIN_SECRET_TOKEN;
      else process.env.OPENCOXSWAIN_SECRET_TOKEN = saved;
    }
  });
});
