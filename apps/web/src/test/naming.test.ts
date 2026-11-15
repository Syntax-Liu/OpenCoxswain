/**
 * 命名约束测试。
 *
 * 规则来自 docs/glossary.md：User / Supervisor / Assistant / Agent，
 * 首字母大写，中文不翻译。A/B/C/D 代号与「项目助理 / 执行者 / 总管」已废弃。
 *
 * 为什么要有这条测试：
 * 这些词会在文案、注释、文档里不断被写回来（我自己就犯过）。
 * 靠人记不住，靠测试锁住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** 界面里不许出现的旧称。 */
const BANNED = [
  '项目助理',
  '全局助理',
  '执行者',
  '总管',
];

function uiFiles(): string[] {
  const dir = resolve(ROOT, 'src/components');
  const top = resolve(ROOT, 'src');
  const out: string[] = [];
  for (const f of readdirSync(top)) {
    if (f.endsWith('.tsx')) out.push(resolve(top, f));
  }
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.tsx') || f.endsWith('.ts')) out.push(resolve(dir, f));
  }
  return out;
}

describe('命名：界面文案必须遵守术语表', () => {
  it('界面源码里不出现废弃旧称', () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const bad of BANNED) {
        if (text.includes(bad)) {
          offenders.push(`${file.split(/[\\/]/).pop()} → 「${bad}」`);
        }
      }
    }
    assert.deepEqual(offenders, [], `发现废弃旧称：\n${offenders.join('\n')}`);
  });

  it('正式名称首字母大写（不出现小写的 assistant/supervisor/agent 作为**展示文案**）', () => {
    // 只查 JSX 里会被渲染成文字的内容（>文本< 或 '文本' 作为显示标签）。
    // 代码里的字符串值（如 role === 'assistant'）是标识符，不在此约束内。
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      // .ts 文件没有 JSX，跳过（它们不产生展示文案）
      if (!file.endsWith('.tsx')) continue;
      const text = readFileSync(file, 'utf8');

      // JSX 文本节点：>xxx< 之间
      for (const m of text.matchAll(/>([^<>{}]{2,60})</g)) {
        const content = m[1]!.trim();
        if (/^(assistant|supervisor|agent)\b/i.test(content) && !/^[A-Z]/.test(content)) {
          offenders.push(`${file.split(/[\\/]/).pop()} → JSX 文本「${content}」`);
        }
      }
    }
    assert.deepEqual(offenders, [], `发现小写展示文案：\n${offenders.join('\n')}`);
  });
});
