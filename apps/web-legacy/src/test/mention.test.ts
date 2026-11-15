/**
 * @ 引用检测测试。
 *
 * 核心约束：**`@某人` 这种普通文本不能弹出文件选择器**。
 * 误弹出很烦——用户只是想打个邮箱或提到某人。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyMention, detectMention } from '../components/mention.js';

describe('检测 @ 引用', () => {
  it('行尾打 @ 就激活', () => {
    const r = detectMention('看 @', 3);
    assert.equal(r.active, true);
    assert.equal(r.query, '');
  });

  it('带查询文本', () => {
    const r = detectMention('看 @login', 10);
    assert.equal(r.active, true);
    assert.equal(r.query, 'login');
  });

  it('**@ 后面有空格就不再是引用**（比如 @某人 说）', () => {
    const r = detectMention('发邮件 @张三 说', 9);
    assert.equal(r.active, false);
  });

  it('没有 @ 时不激活', () => {
    assert.equal(detectMention('普通一句话', 5).active, false);
  });

  it('**新行开头打 @ 能激活**', () => {
    const r = detectMention('第一行\n@src', 10);
    assert.equal(r.active, true);
    assert.equal(r.query, 'src');
  });

  it('光标在 @ 之前时不激活', () => {
    // 文本是 "看 @login"，但光标在位置 1（"看"之后）
    const r = detectMention('看 @login', 1);
    assert.equal(r.active, false);
  });

  it('多个 @ 时取最近的', () => {
    const r = detectMention('@aaa 然后 @bbb', 12);
    assert.equal(r.active, true);
    assert.equal(r.query, 'bbb');
  });

  it('记录 @ 的位置', () => {
    const r = detectMention('看 @log', 7);
    assert.equal(r.start, 2);
  });
});

describe('替换引用', () => {
  it('把 @xxx 换成完整路径', () => {
    const text = '看一下 @log';
    const state = detectMention(text, text.length);
    assert.equal(applyMention(text, state, 'src/login.ts'), '看一下 @src/login.ts ');
  });

  it('保留 @ 后面的内容', () => {
    const text = '看 @log 然后改';
    const state = detectMention('看 @log', 7);
    assert.equal(applyMention(text, state, 'src/login.ts'), '看 @src/login.ts  然后改');
  });

  it('未激活时原样返回', () => {
    const state = { active: false, query: '', start: -1 };
    assert.equal(applyMention('原文', state, 'x.ts'), '原文');
  });

  it('自动补空格（方便继续打字）', () => {
    const text = '@log';
    const state = detectMention(text, 4);
    assert.ok(applyMention(text, state, 'a.ts').endsWith(' '));
  });
});
