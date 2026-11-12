/**
 * 多模态消息测试。
 *
 * 核心约束：**模型不支持图片时，绝不能把图片块发给它**。
 * 多数端点收到图片会直接 400，用户看到"发送失败"却不知道原因。
 *
 * 所以这组测试的重点不是"能发图片"，而是"不该发的时候真的没发"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasImages,
  textOf,
  toWireMessages,
  type ChatMessage,
  type ContentPart,
} from '../llm/types.js';

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

function withParts(parts: readonly ContentPart[]): ChatMessage {
  return { role: 'user', content: null, parts };
}

describe('消息内容提取', () => {
  it('纯文本消息返回 content', () => {
    assert.equal(textOf({ role: 'user', content: '你好' }), '你好');
  });

  it('多模态消息只取文本部分', () => {
    const msg = withParts([
      { type: 'text', text: '看看这个' },
      { type: 'image', dataUrl: IMG },
    ]);
    assert.equal(textOf(msg), '看看这个');
  });

  it('纯图片消息的文本为空', () => {
    const msg = withParts([{ type: 'image', dataUrl: IMG }]);
    assert.equal(textOf(msg), '');
  });

  it('hasImages 正确识别', () => {
    assert.equal(hasImages(withParts([{ type: 'image', dataUrl: IMG }])), true);
    assert.equal(hasImages(withParts([{ type: 'text', text: 'x' }])), false);
    assert.equal(hasImages({ role: 'user', content: 'x' }), false);
  });
});

describe('发给 API 的报文', () => {
  it('**纯文本消息行为完全不变**（兼容性）', () => {
    const wire = toWireMessages([{ role: 'user', content: '你好' }], { supportsImages: false });
    assert.deepEqual(wire, [{ role: 'user', content: '你好' }]);
  });

  it('工具调用字段原样保留', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    };
    const wire = toWireMessages([msg], { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(wire[0]?.tool_calls));
  });
});

describe('支持图片的模型', () => {
  it('**转成标准的 image_url 数组**', () => {
    const msg = withParts([
      { type: 'text', text: '看看这个截图' },
      { type: 'image', dataUrl: IMG },
    ]);
    const wire = toWireMessages([msg], { supportsImages: true }) as Array<Record<string, unknown>>;

    const content = wire[0]?.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(content), '应当是多模态数组');
    assert.equal(content[0]?.type, 'text');
    assert.equal(content[0]?.text, '看看这个截图');
    assert.equal(content[1]?.type, 'image_url');
    assert.deepEqual(content[1]?.image_url, { url: IMG });
  });

  it('多张图片都发出去', () => {
    const msg = withParts([
      { type: 'text', text: '两张' },
      { type: 'image', dataUrl: IMG },
      { type: 'image', dataUrl: IMG },
    ]);
    const wire = toWireMessages([msg], { supportsImages: true }) as Array<Record<string, unknown>>;
    const content = wire[0]?.content as Array<Record<string, unknown>>;
    assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
  });
});

describe('**不支持的模型：绝不发图片块**', () => {
  it('图片降级成文字说明', () => {
    const msg = withParts([
      { type: 'text', text: '看看这个' },
      { type: 'image', dataUrl: IMG, name: 'error.png' },
    ]);
    const wire = toWireMessages([msg], { supportsImages: false }) as Array<Record<string, unknown>>;

    const content = wire[0]?.content;
    assert.equal(typeof content, 'string', '必须退化成正文字符串');
    assert.match(String(content), /看看这个/);
    assert.match(String(content), /error\.png/);
    assert.match(String(content), /不支持读取图片/);
  });

  it('**报文里不出现 base64 数据**', () => {
    const msg = withParts([{ type: 'image', dataUrl: IMG }]);
    const wire = toWireMessages([msg], { supportsImages: false });
    const serialized = JSON.stringify(wire);
    assert.ok(!serialized.includes('iVBORw0KGgo'), '图片数据不该出现在报文里');
  });

  it('**报文里不出现 image_url 类型**', () => {
    const msg = withParts([{ type: 'image', dataUrl: IMG }]);
    const wire = toWireMessages([msg], { supportsImages: false });
    assert.ok(!JSON.stringify(wire).includes('image_url'));
  });

  it('没有名字的图片给占位名', () => {
    const msg = withParts([{ type: 'image', dataUrl: IMG }]);
    const wire = toWireMessages([msg], { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.match(String(wire[0]?.content), /未命名/);
  });
});

describe('边界情况', () => {
  it('parts 为空数组时退回 content', () => {
    const msg: ChatMessage = { role: 'user', content: '原文', parts: [] };
    const wire = toWireMessages([msg], { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.equal(wire[0]?.content, '原文');
  });

  it('只有文本的 parts 也能正常工作', () => {
    const msg = withParts([{ type: 'text', text: '只有文字' }]);
    const wireWithImages = toWireMessages([msg], { supportsImages: true }) as Array<
      Record<string, unknown>
    >;
    // 支持图片但没图片：走纯文本路径更简单
    assert.equal(wireWithImages[0]?.content, '只有文字');
  });

  it('空消息列表', () => {
    assert.deepEqual(toWireMessages([], { supportsImages: true }), []);
  });
});
