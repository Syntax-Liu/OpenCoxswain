/**
 * 记忆层测试。
 *
 * 记忆是最容易被"写脏"的地方：一旦临时指令漏进去，之后每一轮提示词都会带着它。
 * 所以这里对**写入门槛**和**文件可读可改**的验证比常规功能更严。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { checkCandidate, type MemoryCandidate } from '../memory/gate.js';
import { tokenize, rankEntries } from '../memory/search.js';
import { MarkdownMemoryStore, parseMarkdown, safeDirName } from '../memory/store.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isAssistantTurn } from './mock-llm.js';
import type { ChatMessage } from '../llm/types.js';

/** 建一个真实存在的临时目录。
 *
 * openProject 会校验目录真实存在（防止用户输错路径却"成功打开"），
 * 所以测试不能再用虚构路径，必须有实际目录。
 */
const createdDirs: string[] = [];
async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `ocx-${label}-`));
  createdDirs.push(dir);
  return dir;
}


const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-mem-'));
  temps.push(dir);
  return dir;
}

const candidate = (text: string, over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  kind: 'project',
  text,
  source: '测试来源',
  ...over,
});

// ---------------------------------------------------------------------------
// 写入门槛（对齐 TRAE 宝「不会被保存为记忆的信息」）
// ---------------------------------------------------------------------------

describe('记忆写入门槛', () => {
  it('正常结论可以写入', () => {
    assert.equal(checkCandidate(candidate('本项目使用 pnpm 而不是 npm')), null);
  });

  it('拒绝临时指令', () => {
    assert.match(checkCandidate(candidate('这次先用 axios 顶一下')) ?? '', /临时指令/);
    assert.match(checkCandidate(candidate('for now 用 mock 数据')) ?? '', /临时指令/);
  });

  it('拒绝模糊偏好', () => {
    // 用足够长、不会被"过短"先拦下的句子，才能证明模糊检测本身生效
    assert.match(checkCandidate(candidate('可能以后都这样吧')) ?? '', /模糊/);
    assert.match(checkCandidate(candidate('随便都行，你看着办')) ?? '', /模糊/);
  });

  it('拒绝疑似密钥', () => {
    assert.match(checkCandidate(candidate('apiKey: sk-abcdef1234567890')) ?? '', /密钥/);
    assert.match(checkCandidate(candidate('password: hunter2hunter2')) ?? '', /密钥/);
  });

  it('拒绝过短与缺少来源', () => {
    assert.match(checkCandidate(candidate('好')) ?? '', /过短/);
    assert.match(checkCandidate(candidate('这条有来源吗', { source: '' })) ?? '', /来源/);
  });
});

// ---------------------------------------------------------------------------
// 分词与排序
// ---------------------------------------------------------------------------

describe('中文分词与检索排序', () => {
  it('中文按二元组切分', () => {
    const tokens = tokenize('登录页面');
    assert.ok(tokens.includes('登录'));
    assert.ok(tokens.includes('录页'));
    assert.ok(tokens.includes('页面'));
  });

  it('西文按单词切分', () => {
    assert.ok(tokenize('use pnpm build').includes('pnpm'));
  });

  it('覆盖率高的排在前面', () => {
    const now = Date.now();
    const entries = [
      {
        id: 'a',
        kind: 'project' as const,
        text: '登录页使用 React Hook Form',
        source: 's',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'b',
        kind: 'project' as const,
        text: '导出功能用流式响应',
        source: 's',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const ranked = rankEntries(entries, '登录页怎么做的', now, 5);
    assert.equal(ranked[0]?.entry.id, 'a');
  });

  it('空闲时时间衰减让旧记忆降权', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const entries = [
      { id: 'new', kind: 'project' as const, text: '构建命令是 pnpm build', source: 's', createdAt: now, updatedAt: now },
      {
        id: 'old',
        kind: 'project' as const,
        text: '构建命令是 pnpm build',
        source: 's',
        createdAt: now - 400 * day,
        updatedAt: now - 400 * day,
      },
    ];
    const ranked = rankEntries(entries, '构建命令', now, 5);
    assert.equal(ranked[0]?.entry.id, 'new');
  });
});

// ---------------------------------------------------------------------------
// Markdown 存储
// ---------------------------------------------------------------------------

describe('Markdown 记忆存储', () => {
  it('全局与项目分文件存放（对齐 TRAE 宝布局）', async () => {
    const root = await makeRoot();
    const store = new MarkdownMemoryStore({ rootDir: root });

    await store.write({ kind: 'global' }, candidate('偏好中文回答', { kind: 'profile' }));
    await store.write({ kind: 'project', projectKey: 'D:/work/app' }, candidate('用 pnpm'));

    const globalRaw = await readFile(path.join(root, 'user_profile.md'), 'utf8');
    assert.match(globalRaw, /偏好中文回答/);

    const projectFile = path.join(root, 'projects', safeDirName('D:/work/app'), 'project_memory.md');
    const projectRaw = await readFile(projectFile, 'utf8');
    assert.match(projectRaw, /用 pnpm/);
  });

  it('文件是人类可读的 Markdown，带来源与日期', async () => {
    const root = await makeRoot();
    const store = new MarkdownMemoryStore({ rootDir: root });
    await store.write({ kind: 'global' }, candidate('用中文回答我', { kind: 'profile', source: '会话 c_1' }));

    const raw = await readFile(path.join(root, 'user_profile.md'), 'utf8');
    assert.match(raw, /# 用户记忆（全局）/);
    assert.match(raw, /- \[profile\] 用中文回答我/);
    assert.match(raw, /_来源：会话 c_1 · 更新于 \d{4}-\d{2}-\d{2}_/);
  });

  it('重复内容幂等，不会写两条', async () => {
    const root = await makeRoot();
    const store = new MarkdownMemoryStore({ rootDir: root });
    const scope = { kind: 'project', projectKey: 'p' } as const;

    await store.write(scope, candidate('本项目用 pnpm'));
    await store.write(scope, candidate('本项目用 PNPM  '));

    const entries = await store.list(scope);
    assert.equal(entries.length, 1);
  });

  it('替换与删除', async () => {
    const root = await makeRoot();
    const store = new MarkdownMemoryStore({ rootDir: root });
    const scope = { kind: 'project', projectKey: 'p' } as const;

    await store.write(scope, candidate('构建用 npm run build'));
    const [entry] = await store.list(scope);
    assert.ok(entry);

    await store.replace(scope, entry.id, candidate('构建改用 pnpm build'));
    const updated = await store.list(scope);
    assert.equal(updated[0]?.text, '构建改用 pnpm build');

    assert.equal(await store.remove(scope, updated[0]!.id), true);
    assert.equal((await store.list(scope)).length, 0);
  });

  it('用户手写的内容不会破坏解析（只认 - [kind] 行）', async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, 'user_profile.md'),
      [
        '# 我的笔记',
        '',
        '这里是我自己写的一些说明，随便写什么都行。',
        '',
        '- [profile] 回答一律用中文',
        '  _来源：手工 · 更新于 2026-11-01_',
        '',
        '## 其它',
        '- 这条没有类型标记，应该被忽略',
      ].join('\n'),
      'utf8',
    );

    const entries = parseMarkdown(await readFile(path.join(root, 'user_profile.md'), 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, '回答一律用中文');
    assert.equal(entries[0]?.source, '手工');
  });

  it('项目记忆全量注入，全局记忆按相关性注入', async () => {
    const root = await makeRoot();
    const store = new MarkdownMemoryStore({ rootDir: root });
    await store.write({ kind: 'global' }, candidate('我喜欢简洁的回答', { kind: 'profile' }));
    await store.write(
      { kind: 'project', projectKey: 'p' },
      candidate('所有接口都要加鉴权'),
    );

    const rendered = await store.renderForPrompt(
      { kind: 'project', projectKey: 'p' },
      '接口该怎么写',
    );
    assert.match(rendered, /项目记忆（必须遵守）/);
    assert.match(rendered, /所有接口都要加鉴权/);
    // 全局偏好与这句话不相关，不该出现
    assert.doesNotMatch(rendered, /我喜欢简洁的回答/);
  });
});

// ---------------------------------------------------------------------------
// 接入 C：跨重启保留
// ---------------------------------------------------------------------------

describe('记忆接进Assistant', () => {
  it('C 用 remember 写入，下一轮就看到它（跨会话生效）', async () => {
    const root = await makeRoot();
    const memRoot = await makeRoot();
    const memory = new MarkdownMemoryStore({ rootDir: memRoot });
    const seen: string[] = [];

    let turn = 0;
    const llm = new MockLlmClient((request) => {
      const system = request.messages.find((m) => m.role === 'system');
      const sys = typeof system?.content === 'string' ? system.content : '';
      if (!isAssistantTurn(request)) return { text: 'ok' };
      if (sys.startsWith('你是这个项目的「Assistant」')) {
        seen.push(sys);
        turn += 1;
        if (turn === 2) {
          return { tool: 'remember', args: { text: '本项目的构建命令是 pnpm build', kind: 'project' } };
        }
        return { text: '好的。' };
      }
      return { text: 'ok' };
    });

    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm, memory });
    const { project } = await runtime.openProject({ rootPath: await tempDir('memtest') });

    await runtime.userSays(project.id, '我们约定一下构建命令');
    await waitIdle(runtime, project.id);

    await runtime.userSays(project.id, '记住：构建命令是 pnpm build');
    await waitIdle(runtime, project.id);

    // 记忆文件里有
    const entries = await memory.list({ kind: 'project', projectKey: project.rootPath });
    assert.ok(entries.some((e) => e.text.includes('pnpm build')), '应当写进项目记忆');

    // 下一轮对话的系统提示里带上它
    await runtime.userSays(project.id, '构建要跑什么？');
    await waitIdle(runtime, project.id);
    const lastSystem = seen.at(-1) ?? '';
    assert.match(lastSystem, /所有|pnpm build/, '新的一轮必须看到记忆');

    await runtime.dispose();
  });

  it('被门槛拒绝的记忆不会落盘，且如实告诉模型', async () => {
    const memRoot = await makeRoot();
    const memory = new MarkdownMemoryStore({ rootDir: memRoot });
    const toolResults: string[] = [];

    const llm = new MockLlmClient((request) => {
      const sys = String(request.messages.find((m) => m.role === 'system')?.content ?? '');
      if (!isAssistantTurn(request) || !sys.startsWith('你是这个项目的「Assistant」')) {
        return { text: 'ok' };
      }
      const toolMsgs = request.messages.filter((m) => m.role === 'tool');
      if (toolMsgs.length > 0) {
        toolResults.push(String(toolMsgs[0]!.content));
        return { text: '明白了，这条不记。' };
      }
      return { tool: 'remember', args: { text: '这次临时用 mock', kind: 'project' }, text: '记一下' };
    });

    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm, memory });
    const { project } = await runtime.openProject({ rootPath: await tempDir('reject') });

    await runtime.userSays(project.id, '这次先这样');
    await waitIdle(runtime, project.id);

    assert.equal((await memory.list({ kind: 'project', projectKey: project.rootPath })).length, 0);
    assert.ok(toolResults.some((r) => r.includes('临时指令')), '拒绝原因要回给模型');

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------

async function waitIdle(runtime: Orchestrator, projectId: string, timeout = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!runtime.getAssistant(projectId)?.isRunning) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待空闲超时');
}

void ({} as ChatMessage);
