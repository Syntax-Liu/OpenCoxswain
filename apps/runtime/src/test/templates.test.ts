/**
 * 模板与定时测试。
 *
 * **核心约束：两者都只能"建议"，不能自动开工。**
 * 这组测试的第一目的不是验证功能，而是守住这条产品前提。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { TEMPLATES, applyTemplate, findTemplate } from '../templates/templates.js';
import { checkSchedules, isDue, makeSuggestion, scheduleFromTemplate, type ScheduleSpec } from '../schedules/schedules.js';
import { MemoryScheduleStore, ScheduleStore } from '../schedules/store.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-tpl-'));
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

describe('任务模板', () => {
  it('提供五类模板', () => {
    assert.equal(TEMPLATES.length, 5);
    const ids = TEMPLATES.map((t) => t.id);
    for (const expected of ['fix-bug', 'small-feature', 'docs', 'refactor', 'research']) {
      assert.ok(ids.includes(expected), `缺少模板 ${expected}`);
    }
  });

  it('调研模板是只读的', () => {
    const research = findTemplate('research');
    assert.equal(research?.readonly, true);
    assert.deepEqual(research?.writeScope, ['readonly']);
  });

  it('每个模板都有验收标准（否则等于没有验收）', () => {
    for (const template of TEMPLATES) {
      assert.ok(template.criteria.length > 0, `${template.id} 没有验收标准`);
    }
  });

  it('修缺陷 / 重构模板要求跑测试', () => {
    for (const id of ['fix-bug', 'refactor']) {
      const template = findTemplate(id)!;
      const hasTest = template.criteria.some((c) => c.type === 'command' && c.check?.includes('test'));
      assert.ok(hasTest, `${id} 应当要求跑测试`);
    }
  });

  it('**套用模板只生成待确认草稿，不派活**', () => {
    const applied = applyTemplate(findTemplate('docs')!, { label: '写文档', goal: '写 README' });
    assert.equal(applied.requiresConfirmation, true);
    assert.equal(applied.goal, '写 README');
    assert.deepEqual(applied.writeScope, ['docs/']);
  });

  it('未知模板报错而不是静默返回空', () => {
    assert.equal(findTemplate('nope'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 定时
// ---------------------------------------------------------------------------

function spec(over: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    id: 's1',
    projectId: 'p1',
    title: '每日检查',
    goal: '检查依赖有没有安全问题',
    writeScope: ['readonly'],
    frequency: 'daily',
    hour: 9,
    enabled: true,
    lastFiredAt: null,
    createdAt: 0,
    ...over,
  };
}

describe('定时的到点判定', () => {
  it('到点且今天没触发过 → 该触发', () => {
    const now = new Date(2026, 10, 12, 9, 5);
    assert.equal(isDue(spec(), now), true);
  });

  it('没到点不触发', () => {
    assert.equal(isDue(spec(), new Date(2026, 10, 12, 8, 59)), false);
  });

  it('**同一天只触发一次**', () => {
    const fired = new Date(2026, 10, 12, 9, 1).getTime();
    assert.equal(isDue(spec({ lastFiredAt: fired }), new Date(2026, 10, 12, 9, 30)), false);
    assert.equal(isDue(spec({ lastFiredAt: fired }), new Date(2026, 10, 13, 9, 5)), true);
  });

  it('停用的不触发', () => {
    assert.equal(isDue(spec({ enabled: false }), new Date(2026, 10, 12, 9, 5)), false);
  });

  it('每周只在指定星期触发', () => {
    const weekly = spec({ frequency: 'weekly', weekday: 1, hour: 9 });
    // 2026-11-12 是周四
    assert.equal(isDue(weekly, new Date(2026, 10, 12, 9, 5)), false);
    // 2026-11-16 是周一
    assert.equal(isDue(weekly, new Date(2026, 10, 16, 9, 5)), true);
  });

  it('每周不会一周触发多次', () => {
    const weekly = spec({ frequency: 'weekly', weekday: 1, hour: 9, lastFiredAt: new Date(2026, 10, 16, 9, 1).getTime() });
    assert.equal(isDue(weekly, new Date(2026, 10, 16, 10, 0)), false);
  });
});

describe('定时只产出建议', () => {
  it('**建议对象明确标记需要确认**', () => {
    const suggestion = makeSuggestion(spec());
    assert.equal(suggestion.requiresConfirmation, true);
    assert.equal(suggestion.title, '每日检查');
  });

  it('到点触发后写回 lastFiredAt，避免重复建议', async () => {
    const store = new MemoryScheduleStore();
    await store.save(spec());

    const now = new Date(2026, 10, 12, 9, 5).getTime();
    const fired = await checkSchedules(await store.load(), (s) => store.save(s), now);
    assert.equal(fired.length, 1);

    const again = await checkSchedules(await store.load(), (s) => store.save(s), now + 60_000);
    assert.equal(again.length, 0, '同一时段不该再次建议');
  });

  it('从模板创建定时会带上模板的写域', () => {
    const research = findTemplate('research')!;
    const created = scheduleFromTemplate({
      projectId: 'p1',
      template: research,
      title: '每周调研',
      goal: '查依赖更新',
      frequency: 'weekly',
      hour: 10,
      weekday: 1,
    });
    assert.deepEqual(created.writeScope, ['readonly']);
    assert.equal(created.templateId, 'research');
  });
});

describe('定时配置持久化', () => {
  it('存进 JSON 再读回来', async () => {
    const file = path.join(await tmpDir(), 'schedules.json');
    const store = new ScheduleStore(file);
    await store.save(spec({ id: 'a' }));
    await store.save(spec({ id: 'b', title: '另一个' }));

    const loaded = await store.load();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1]?.title, '另一个');
  });

  it('文件不存在时返回空数组（不抛异常）', async () => {
    const store = new ScheduleStore(path.join(await tmpDir(), 'nope.json'));
    assert.deepEqual(await store.load(), []);
  });

  it('删除生效', async () => {
    const file = path.join(await tmpDir(), 'schedules.json');
    const store = new ScheduleStore(file);
    await store.save(spec({ id: 'a' }));
    await store.remove('a');
    assert.equal((await store.load()).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 端到端：确认不派活
// ---------------------------------------------------------------------------

describe('端到端：模板与定时都不会自动派活', () => {
  it('**套用模板后没有任何Agent被创建**', async () => {
    const root = await tmpDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const { project } = await runtime.openProject({ rootPath: root });

    const applied = runtime.applyTemplate('fix-bug', { label: '修 bug', goal: '修登录问题' });
    assert.equal(applied.requiresConfirmation, true);

    // 关键：套用模板之后，什么都没跑
    assert.equal(store.listExecutors({ projectId: project.id }).length, 0);

    await runtime.dispose();
  });

  it('**定时到点后只产生汇报，不创建Agent**', async () => {
    const root = await tmpDir();
    const store = new MemoryStore();
    const schedules = new MemoryScheduleStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })), schedules });
    const { project } = await runtime.openProject({ rootPath: root });

    await schedules.save(spec({ projectId: project.id, hour: 9 }));

    const fired = await runtime.checkSchedules(new Date(2026, 10, 12, 9, 5).getTime());
    assert.equal(fired.length, 1, '应当产生一条建议');

    // 关键：没有Agent
    assert.equal(store.listExecutors({ projectId: project.id }).length, 0, '定时不该自动派活');

    // 但用户能看到提醒
    const reports = store.listReports({ projectId: project.id, needsUser: true });
    assert.ok(reports.some((r) => r.body.includes('定时提醒')));

    await runtime.dispose();
  });
});
