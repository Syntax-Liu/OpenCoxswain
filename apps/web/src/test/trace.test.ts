/**
 * 轨迹页数据整理测试。
 *
 * 这组测试守的是"轨迹页显示什么"的边界：
 * - 对话页隐藏的内部通知，轨迹页**要**显示（排查时最需要它）
 * - 工具调用要从 JSON 里取出最有辨识度的字段当摘要
 * - 顺序按时间，不按到达顺序
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MessageDto } from '../api.js';
import {
  buildTrace,
  describeSpan,
  extractToolArgs,
  extractToolName,
  summarizeAssistant,
  summarizeToolCall,
  timelineSegments,
} from '../components/trace.js';

function msg(over: Partial<MessageDto> & { id: string; role: MessageDto['role'] }): MessageDto {
  return {
    content: '',
    source: 'assistant',
    at: 0,
    ...over,
  } as MessageDto;
}

describe('工具调用摘要', () => {
  it('从 JSON 里取 command', () => {
    assert.equal(
      summarizeToolCall('{"command":"pnpm test","cwd":"D:/x"}'),
      'command: pnpm test',
    );
  });

  it('没有 command 时取 path', () => {
    assert.equal(summarizeToolCall('{"path":"src/a.ts"}'), 'path: src/a.ts');
  });

  it('不认识的字段退回第一个键', () => {
    assert.equal(summarizeToolCall('{"foo":"bar"}'), 'foo: bar');
  });

  it('非 JSON 按纯文本处理', () => {
    assert.equal(summarizeToolCall('大概是想改登录页'), '大概是想改登录页');
  });

  it('空内容给占位', () => {
    assert.equal(summarizeToolCall('   '), '（空）');
  });

  it('太长的值被截断', () => {
    const long = 'x'.repeat(300);
    const out = summarizeToolCall(`{"command":"${long}"}`);
    assert.ok(out.length < 200, `不该这么长：${out.length}`);
    assert.ok(out.endsWith('…'));
  });
});

describe('助手回复摘要', () => {
  it('压成一行并去掉 Markdown 标记', () => {
    const out = summarizeAssistant('## 标题\n\n**重点**：完成');
    assert.ok(!out.includes('#'));
    assert.ok(!out.includes('**'));
    assert.match(out, /标题/);
  });

  it('代码块被折叠成占位', () => {
    const out = summarizeAssistant('前\n```\nconst a = 1;\n```\n后');
    assert.match(out, /代码块/);
    assert.ok(!out.includes('const a'));
  });
});

describe('轨迹整理', () => {
  it('**内部通知也进轨迹**（对话页看不到，这里要能看）', () => {
    const messages: MessageDto[] = [
      msg({ id: 'm1', role: 'user', content: '改登录页', at: 1 }),
      msg({ id: 'm2', role: 'user', content: '【结算】完成', at: 2, internal: true }),
    ];
    const trace = buildTrace(messages);
    assert.equal(trace.total, 2, 'internal 消息不该被丢掉');
    assert.ok(trace.entries.some((e) => e.label === '系统通知'));
  });

  it('system 消息被排除', () => {
    const trace = buildTrace([msg({ id: 's', role: 'system', content: '你是…', at: 0 })]);
    assert.equal(trace.total, 0);
  });

  it('按时间排序，不按到达顺序', () => {
    const messages: MessageDto[] = [
      msg({ id: 'b', role: 'assistant', content: '第二', at: 200 }),
      msg({ id: 'a', role: 'user', content: '第一', at: 100 }),
    ];
    const trace = buildTrace(messages);
    assert.deepEqual(
      trace.entries.map((e) => e.id),
      ['a', 'b'],
    );
  });

  it('**工具消息按 source 识别**（真实格式：role 是 user，source 是 tool）', () => {
    const trace = buildTrace([
      msg({
        id: 't',
        role: 'user',
        content: '`run_command` {"command":"ls"}',
        source: 'tool',
        at: 1,
      }),
    ]);
    assert.equal(trace.entries[0]?.label, '工具');
    assert.match(trace.entries[0]?.title ?? '', /command: ls/);
  });

  it('工具结果按 source 识别', () => {
    const trace = buildTrace([
      msg({ id: 'r', role: 'assistant', content: '文件已创建', source: 'tool-result', at: 2 }),
    ]);
    assert.equal(trace.entries[0]?.label, '结果');
    assert.equal(trace.entries[0]?.kind, 'tool');
  });

  it('统计各类条数', () => {
    const trace = buildTrace([
      msg({ id: '1', role: 'user', content: 'a', at: 1 }),
      msg({ id: '2', role: 'assistant', content: 'b', at: 2 }),
      msg({ id: '3', role: 'user', content: '`x` {"command":"x"}', source: 'tool', at: 3 }),
      msg({ id: '4', role: 'assistant', content: 'ok', source: 'tool-result', at: 4 }),
    ]);
    assert.deepEqual(trace.counts, { user: 1, assistant: 1, tool: 2 });
  });

  it('提取工具名与参数', () => {
    assert.equal(extractToolName('`run_command` {"command":"ls"}'), 'run_command');
    assert.equal(extractToolArgs('`run_command` {"command":"ls"}'), '{"command":"ls"}');
    assert.equal(extractToolName('没有反引号'), null);
  });

  it('时间跨度按首尾算', () => {
    const trace = buildTrace([
      msg({ id: '1', role: 'user', content: 'a', at: 1000 }),
      msg({ id: '2', role: 'assistant', content: 'b', at: 61000 }),
    ]);
    assert.equal(trace.spanMs, 60000);
  });

  it('只有一条时跨度是 0', () => {
    const trace = buildTrace([msg({ id: '1', role: 'user', content: 'a', at: 1000 })]);
    assert.equal(trace.spanMs, 0);
  });

  it('时间轴分段数等于条目数', () => {
    const trace = buildTrace([
      msg({ id: '1', role: 'user', content: 'a', at: 1 }),
      msg({ id: '2', role: 'tool', content: '{}', at: 2 }),
    ]);
    assert.equal(timelineSegments(trace).length, 2);
  });
});

describe('时长展示', () => {
  it('0 显示破折号', () => {
    assert.equal(describeSpan(0), '—');
  });

  it('小于一分钟显示秒', () => {
    assert.equal(describeSpan(42000), '42 秒');
  });

  it('整分钟不带秒', () => {
    assert.equal(describeSpan(120000), '2 分');
  });

  it('分秒都显示', () => {
    assert.equal(describeSpan(192000), '3 分 12 秒');
  });

  it('**超过一小时用小时表达**（早期算成"1397 分"不像人话）', () => {
    // 20 小时
    assert.equal(describeSpan(20 * 3600 * 1000), '20 小时');
    // 2 小时 15 分
    assert.equal(describeSpan(2 * 3600 * 1000 + 15 * 60000), '2 小时 15 分');
    // 1 小时 39 分 57 秒 → 只保留到分
    assert.equal(describeSpan(5997000), '1 小时 39 分');
  });
});
