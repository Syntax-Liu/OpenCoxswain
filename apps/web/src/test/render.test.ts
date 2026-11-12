/**
 * 对话流过滤与 Markdown 行内解析测试。
 *
 * 这两块的错误都很直观：
 * - 过滤错了 → 内部通知漏进对话，或用户消息丢失；
 * - 解析错了 → `**结论**` 原样显示成星号。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inline } from '../components/Markdown.js';
import type { MessageDto } from '../api.js';

/** 与 Conversation 组件里一致的过滤规则。 */
function visibleMessages(messages: readonly MessageDto[]): MessageDto[] {
  return messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.internal);
}

const msg = (over: Partial<MessageDto>): MessageDto => ({
  id: 'm',
  role: 'user',
  content: '',
  source: 'webapp',
  at: 0,
  ...over,
});

describe('对话流过滤', () => {
  it('只保留用户与 Assistant 的消息', () => {
    const list = [
      msg({ id: '1', role: 'user', content: '你好' }),
      msg({ id: '2', role: 'assistant', content: '收到' }),
      msg({ id: '3', role: 'tool', content: '工具输出' }),
      msg({ id: '4', role: 'system', content: '系统' }),
    ];
    assert.deepEqual(
      visibleMessages(list).map((m) => m.id),
      ['1', '2'],
    );
  });

  it('内部通知被过滤（回归：曾整块显示【Agent结算】）', () => {
    const list = [
      msg({ id: '1', role: 'user', content: '创建文件' }),
      msg({
        id: '2',
        role: 'user',
        content: '【Agent结算】\n已完成\n请立刻向用户汇报这一条结果。',
        source: 'internal:executor',
        internal: true,
      }),
      msg({ id: '3', role: 'assistant', content: '已完成' }),
    ];
    const visible = visibleMessages(list);
    assert.deepEqual(
      visible.map((m) => m.id),
      ['1', '3'],
    );
    for (const m of visible) {
      assert.doesNotMatch(m.content, /请立刻向用户汇报/);
    }
  });

  it('undefined 的 internal 视为普通消息（兼容旧数据）', () => {
    const list = [msg({ id: '1', role: 'user', content: '旧消息', internal: undefined })];
    assert.equal(visibleMessages(list).length, 1);
  });
});

/** 从 ReactNode 里找出指定 type 的元素，并取出它的 children。 */
function findElement(nodes: readonly unknown[], type: string): string | undefined {
  for (const node of nodes) {
    if (node && typeof node === 'object' && 'type' in node) {
      const el = node as { type: unknown; props?: { children?: unknown } };
      if (el.type === type) {
        const children = el.props?.children;
        return typeof children === 'string' ? children : String(children);
      }
    }
  }
  return undefined;
}

describe('Markdown 行内解析', () => {
  it('**粗体** 不再原样显示星号', () => {
    const nodes = inline('**结论**：已创建');
    assert.equal(findElement(nodes, 'strong'), '结论');
  });

  it('行内代码', () => {
    const nodes = inline('文件 `a.txt` 已创建');
    assert.equal(findElement(nodes, 'code'), 'a.txt');
  });

  it('纯文本原样返回，不误伤', () => {
    const nodes = inline('没有标记的一行');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0], '没有标记的一行');
  });

  it('粗体里含中文标点正常', () => {
    const nodes = inline('**重要约束：只读**');
    assert.equal(findElement(nodes, 'strong'), '重要约束：只读');
  });
});
