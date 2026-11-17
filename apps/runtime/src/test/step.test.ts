/**
 * 用户看到的「当前在做什么」必须**真实**。
 *
 * 这几条测试守的是 `desktop-agent-ui` 的核心铁律：
 *
 * > 动作与状态严格真实对应……严禁用动画延迟或前端计时器伪造执行进度。
 *
 * 所以 `describeStep` 的铁律是：**只从真实参数里提取，绝不猜**。
 * 拿不到路径就如实说"读取"，而不是编一个看起来更丰富的描述。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeStep } from '../executor/step.js';

describe('**步骤描述：动词 + 对象**', () => {
  it('读取文件只显示文件名，不显示整条路径', () => {
    const step = describeStep('read_file', { path: 'src/auth/login.tsx' });
    assert.equal(step.label, '读取 login.tsx');
    assert.equal(step.tool, 'read_file');
  });

  it('写文件', () => {
    assert.equal(describeStep('write_file', { path: 'a/b/c.ts' }).label, '写入 c.ts');
  });

  it('修改文件（多种工具名都认）', () => {
    for (const name of ['edit_file', 'Edit', 'str_replace', 'apply_patch']) {
      assert.equal(describeStep(name, { path: 'x/y.tsx' }).label, '修改 y.tsx');
    }
  });

  it('Windows 反斜杠路径也能取到文件名', () => {
    const step = describeStep('read_file', { path: 'D:\\repo\\src\\App.tsx' });
    assert.equal(step.label, '读取 App.tsx');
  });

  it('运行命令只显示很短的命令前缀', () => {
    const step = describeStep('bash', { command: 'pnpm test && echo done' });
    assert.ok(step.label.startsWith('运行命令'), step.label);
    // 不能把整条管道命令塞进界面
    assert.ok(!step.label.includes('&&'), step.label);
  });

  it('搜索显示查询词', () => {
    const step = describeStep('grep', { pattern: 'laneStatusOf' });
    assert.equal(step.label, '搜索 laneStatusOf');
  });
});

describe('**拿不到对象就不编造**', () => {
  it('没有 path 参数时只说动词', () => {
    assert.equal(describeStep('read_file', {}).label, '读取');
    assert.equal(describeStep('read_file', undefined).label, '读取');
  });

  it('path 是空字符串时也退化为动词', () => {
    assert.equal(describeStep('write_file', { path: '   ' }).label, '写入');
  });

  it('未知工具如实说「调用 X」，不假装知道它在干什么', () => {
    assert.equal(describeStep('some_custom_tool', {}).label, '调用 some_custom_tool');
  });

  it('参数不是对象也不炸', () => {
    // 运行时防御：模型可能给出任意 JSON
    assert.doesNotThrow(() => describeStep('read_file', null as never));
  });
});

describe('**超长内容会被截断**', () => {
  it('长命令前缀带省略号', () => {
    const long = 'x'.repeat(100);
    const step = describeStep('bash', { command: long });
    assert.ok(step.label.endsWith('…'), step.label);
    assert.ok(step.label.length < 40, `${step.label.length} 太长`);
  });

  it('长查询词带省略号', () => {
    const step = describeStep('grep', { pattern: 'y'.repeat(100) });
    assert.ok(step.label.endsWith('…'), step.label);
  });
});

describe('**批量操作说清楚有几个**', () => {
  it('多个文件时显示数量', () => {
    const step = describeStep('read_file', { paths: ['a.ts', 'b.ts', 'c.ts'] });
    assert.equal(step.label, '读取 a.ts 等 3 个文件');
  });

  it('单个文件时不显示"等 N 个"', () => {
    const step = describeStep('read_file', { paths: ['only.ts'] });
    assert.equal(step.label, '读取 only.ts');
  });
});

describe('**每条都有时间戳**', () => {
  it('at 是合理的毫秒时间', () => {
    const before = Date.now();
    const step = describeStep('read_file', { path: 'a.ts' });
    assert.ok(step.at >= before && step.at <= Date.now());
  });
});
