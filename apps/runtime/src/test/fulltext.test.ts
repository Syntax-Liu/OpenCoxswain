/**
 * 全文搜索测试。
 *
 * 核心约束：
 * 1. **中文要能搜**（不分词，整段子串匹配）
 * 2. 多个词是 AND 语义（搜"登录 测试"要两者都有）
 * 3. 片段要能让人一眼看出"为什么这条被搜到"
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeSnippet, matchesAll, searchMessages, tokenize } from '../search/fulltext.js';

describe('分词', () => {
  it('按空白切', () => {
    assert.deepEqual(tokenize('登录 测试'), ['登录', '测试']);
  });

  it('小写化', () => {
    assert.deepEqual(tokenize('Login'), ['login']);
  });

  it('多余空白被忽略', () => {
    assert.deepEqual(tokenize('  a   b  '), ['a', 'b']);
  });

  it('空查询返回空', () => {
    assert.deepEqual(tokenize('   '), []);
  });
});

describe('AND 语义', () => {
  it('**所有词都要命中**', () => {
    assert.equal(matchesAll('修复登录页并加了测试', ['登录', '测试']), true);
  });

  it('缺一个就不算命中', () => {
    assert.equal(matchesAll('修复登录页', ['登录', '测试']), false);
  });

  it('不区分大小写', () => {
    assert.equal(matchesAll('Fix Login Bug', ['login']), true);
  });

  it('空词表不命任中', () => {
    assert.equal(matchesAll('任何文本', []), false);
  });
});

describe('片段', () => {
  it('**含命中位置附近的内容**', () => {
    const text = '前面一堆无关的话，'.repeat(10) + '这里提到了登录页的问题' + '，后面还有很多'.repeat(10);
    const snippet = makeSnippet(text, ['登录页']);
    assert.ok(snippet.includes('登录页'), `片段里应有命中词: ${snippet}`);
  });

  it('远处有省略号', () => {
    const text = 'x'.repeat(300) + '登录' + 'y'.repeat(300);
    const snippet = makeSnippet(text, ['登录']);
    assert.ok(snippet.startsWith('…'));
    assert.ok(snippet.endsWith('…'));
  });

  it('开头命中不带前置省略号', () => {
    const snippet = makeSnippet('登录问题很好', ['登录']);
    assert.ok(!snippet.startsWith('…'));
  });

  it('换行被压成空格（片段要单行）', () => {
    const snippet = makeSnippet('第一行\n第二行登录', ['登录']);
    assert.ok(!snippet.includes('\n'));
  });

  it('没有命中时取开头', () => {
    assert.ok(makeSnippet('abcdefg', ['zzz']).length > 0);
  });

  it('空文本返回空', () => {
    assert.equal(makeSnippet('', ['a']), '');
  });
});

describe('搜索消息', () => {
  const messages = [
    { id: 'm1', sessionId: 's1', projectId: 'p1', role: 'user', content: '帮我改登录页', at: 1000 },
    { id: 'm2', sessionId: 's1', projectId: 'p1', role: 'assistant', content: '登录页已改好，并加了测试', at: 2000 },
    { id: 'm3', sessionId: 's2', projectId: 'p1', role: 'user', content: '重构数据库连接', at: 3000 },
    { id: 'm4', sessionId: 's3', projectId: 'p2', role: 'user', content: '另一个项目的登录逻辑', at: 4000 },
  ];

  it('搜到相关消息', () => {
    const hits = searchMessages(messages, '登录');
    assert.equal(hits.length, 3);
  });

  it('**新的排在前面**', () => {
    const hits = searchMessages(messages, '登录');
    assert.equal(hits[0]?.messageId, 'm4', '最新的应该第一条');
  });

  it('多词 AND', () => {
    const hits = searchMessages(messages, '登录 测试');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.messageId, 'm2');
  });

  it('按项目过滤', () => {
    const hits = searchMessages(messages, '登录', { projectId: 'p1' });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.projectId === 'p1'));
  });

  it('限制条数', () => {
    assert.ok(searchMessages(messages, '登录', { limit: 1 }).length === 1);
  });

  it('空查询返回空', () => {
    assert.deepEqual(searchMessages(messages, ''), []);
  });

  it('没有匹配返回空', () => {
    assert.deepEqual(searchMessages(messages, '不存在的东西'), []);
  });

  it('结果带片段', () => {
    const hits = searchMessages(messages, '数据库');
    assert.ok(hits[0]?.snippet.includes('数据库'));
  });

  it('英文检索', () => {
    const msgs = [
      { id: 'a', sessionId: 's', projectId: 'p', role: 'user', content: 'Fix the Login bug', at: 1 },
    ];
    assert.equal(searchMessages(msgs, 'login').length, 1);
  });
});
