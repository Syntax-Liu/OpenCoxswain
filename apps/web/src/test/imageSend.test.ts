/**
 * 图片必须真的发出去。
 *
 * ## 为什么需要这条测试
 *
 * 用户拖图进输入框、点发送，**界面上有附件卡**，但 Assistant 回
 * "我收到的只有文字，没有任何图片附件"。
 *
 * 根因：App 里写的是
 *
 * ```tsx
 * onSend={(text) => void handleSendToAssistant(text)}
 * ```
 *
 * —— 只取了第一个参数，`images` 被**静默丢掉**。
 * `handleSendToAssistant` 和 `api.say` 都完整支持图片，
 * 断点只在这一处；而 TypeScript 不会报错（第二个参数是可选的）。
 *
 * 这类"参数被吃掉"的 bug，**只有端到端跑才会发现**，
 * 单看任何一层的代码都是对的。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (p: string): string => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

const app = read('App.tsx');
const conversation = read('components/Conversation.tsx');
const api = read('api.ts');

describe('**发送时图片不能丢**', () => {
  /**
   * 取出 `<Conversation ... onSend={...}` 那一个。
   *
   * 不能简单用 `/<Conversation[\s\S]*?onSend=\{([^}]*)\}/` ——
   * `[\s\S]*?` 会一路吃到后面 `<ExecutorChat>` 的 onSend，
   * 匹配到错的那个（ExecutorChat 本来就不收图片）。
   */
  function conversationOnSend(): string {
    const start = app.indexOf('<Conversation');
    assert.ok(start > 0, '找不到 <Conversation');
    const end = app.indexOf('<ExecutorChat', start);
    assert.ok(end > start, '找不到 <Conversation> 的结束位置');
    const block = app.slice(start, end);

    // **只找行首就是 onSend 的**：
    // 注释里也可能出现 `onSend={(text) => ...}`（正是写来说明"之前错在哪"的），
    // 不过滤就会匹配到注释那一行。
    const matches = [...block.matchAll(/^\s*onSend=\{([^}]*)\}/gm)];
    assert.ok(matches.length > 0, '<Conversation> 里没有 onSend 属性');
    return matches[matches.length - 1]?.[1] ?? '';
  }

  it('App 的 onSend 接收并转发 images', () => {
    const handler = conversationOnSend();
    assert.match(
      handler,
      /handleSendToAssistant\([^)]*images\)/,
      `onSend 没把 images 传给 handleSendToAssistant（实际：${handler.trim()}）`,
    );
  });

  it('**不能只写 (text) =>**（那正是之前的 bug）', () => {
    const handler = conversationOnSend();
    assert.doesNotMatch(
      handler,
      /^\(text\)\s*=>/,
      'onSend 只声明了 text 参数，images 会被静默丢掉',
    );
  });

  it('handleSendToAssistant 把 images 传给 api.say', () => {
    assert.match(app, /api\.say\([^)]*images\)/);
  });

  it('api.say 会把 images 放进请求体', () => {
    const m = /say\([\s\S]{0,600}?images && images\.length > 0[\s\S]{0,80}?images/.exec(api);
    assert.ok(m, 'api.say 没把 images 放进 body');
  });

  it('Conversation 发出时带上了 imageParts', () => {
    assert.match(conversation, /onSend\([^)]*imageParts\(/);
  });
});

describe('附件卡不溢出', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string): string => {
    const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
      css,
    );
    return m ? (m[1] ?? '') : '';
  };

  it('.attachment-name 有 min-width: 0（否则长文件名顶出去）', () => {
    assert.match(rule('.attachment-name'), /min-width:\s*0/);
  });

  it('**附件卡覆盖了全局 button 的固定高度**', () => {
    const body = rule('.attachment-chip');
    assert.ok(body, 'CSS 里没有 .attachment-chip');
    // chip 里是 28px 缩略图，而 btn--sm / button 给的是 22-26px
    assert.match(
      body,
      /height:\s*auto/,
      '.attachment-chip 没覆盖 height —— 28px 缩略图会被压出 22px 的框',
    );
  });

  it('缩略图不被压缩', () => {
    assert.match(rule('.attachment-thumb'), /flex:\s*none/);
  });
});
