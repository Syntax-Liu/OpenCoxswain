import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { htmlToText, readUrl, webSearch } from '../executor/web.js';

describe('htmlToText', () => {
  it('去掉标签只留正文', () => {
    const html = '<html><body><p>Hello</p><p>World</p></body></html>';
    assert.equal(htmlToText(html), 'Hello\nWorld');
  });

  it('丢掉 script 和 style 的内容', () => {
    const html = '<div>keep</div><script>var x = 1;</script><style>.a{}</style>';
    const text = htmlToText(html);
    assert.match(text, /keep/);
    assert.doesNotMatch(text, /var x/);
    assert.doesNotMatch(text, /\.a\{/);
  });

  it('丢掉注释', () => {
    assert.doesNotMatch(htmlToText('<p>a</p><!-- hidden --><p>b</p>'), /hidden/);
  });

  it('br 和块级标签变成换行', () => {
    assert.equal(htmlToText('a<br>b'), 'a\nb');
    assert.equal(htmlToText('<h1>A</h1><p>B</p>'), 'A\nB');
  });

  it('li 变成破折号', () => {
    assert.match(htmlToText('<ul><li>one</li></ul>'), /- one/);
  });

  it('解码常见实体', () => {
    assert.equal(htmlToText('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>');
    assert.equal(htmlToText('<p>x&nbsp;y</p>'), 'x y');
  });

  it('压缩连续空行', () => {
    const text = htmlToText('<p>a</p>\n\n\n\n<p>b</p>');
    assert.doesNotMatch(text, /\n\n\n/);
  });
});

describe('readUrl', () => {
  it('**拒绝非 http(s)**（file:// 能绕过目录限制）', async () => {
    const r = await readUrl('file:///etc/passwd');
    assert.equal(r.ok, false);
    assert.match(r.content, /只支持 http\/https/);
  });

  it('拒绝非法 URL', async () => {
    const r = await readUrl('not a url');
    assert.equal(r.ok, false);
    assert.match(r.content, /不是合法的 URL/);
  });

  it('连不上时如实报错，不抛异常', async () => {
    // 保留端口，基本不会有人监听
    const r = await readUrl('http://127.0.0.1:9/x', { timeoutMs: 1500 });
    assert.equal(r.ok, false);
    assert.ok(r.content.length > 0);
  });
});

describe('webSearch', () => {
  it('**没配置时明确说不可用**', async () => {
    const r = await webSearch('test', null);
    assert.equal(r.ok, false);
    assert.match(r.content, /未配置/);
    // 关键：要告诉模型别假装搜过
    assert.match(r.content, /不要假装搜索过/);
  });

  it('endpoint 为空也当没配', async () => {
    const r = await webSearch('x', { endpoint: '', apiKey: 'k' });
    assert.equal(r.ok, false);
  });

  it('key 为空也当没配', async () => {
    const r = await webSearch('x', { endpoint: 'https://x', apiKey: '' });
    assert.equal(r.ok, false);
  });
});
