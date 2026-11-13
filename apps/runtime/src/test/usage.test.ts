/**
 * 使用报告。
 *
 * 一个原则：**只统计，不评价**。
 * 产品不该替用户判断"你效率如何"，只呈现事实。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildUsageReport, categorizeFailure, renderUsage } from '../insights/usage.js';

const DAY = 86_400_000;
const now = 1_700_000_000_000;

const mk = (over: {
  executors?: unknown[];
  effects?: unknown[];
  projects?: unknown[];
  days?: number;
} = {}) => ({
  days: over.days ?? 7,
  now,
  executors: (over.executors ?? []) as never[],
  effects: (over.effects ?? []) as never[],
  projects: (over.projects ?? []) as never[],
});

const exec = (status: string, createdAt = now - DAY, blockedReason: string | null = null) => ({
  status,
  label: 'x',
  createdAt,
  blockedReason,
});

describe('任务统计', () => {
  it('**只算窗口内的**', () => {
    const r = buildUsageReport(
      mk({
        executives: undefined,
        executors: [
          exec('done', now - DAY), // 窗口内
          exec('done', now - 30 * DAY), // 窗口外
        ],
      } as never),
    );
    assert.equal(r.executors.total, 1);
  });

  it('按状态分开计数', () => {
    const r = buildUsageReport(
      mk({ executors: [exec('done'), exec('done'), exec('failed'), exec('cancelled')] }),
    );
    assert.equal(r.executors.done, 2);
    assert.equal(r.executors.failed, 1);
    assert.equal(r.executors.cancelled, 1);
  });

  it('**成功率只按已结束的算**', () => {
    const r = buildUsageReport(
      mk({
        executors: [exec('done'), exec('done'), exec('done'), exec('failed')],
      }),
    );
    // 3 完成 / 4 已结束 = 75%
    assert.equal(r.successRate, 75);
  });

  it('还没跑完的任务不算进成功率', () => {
    const r = buildUsageReport(
      mk({
        executors: [exec('done'), exec('running'), exec('queued')],
      }),
    );
    assert.equal(r.successRate, 100, '只有 1 个已结束且成功');
  });

  it('一个都没结束时成功率是 null，不是 0', () => {
    const r = buildUsageReport(mk({ executors: [exec('running')] }));
    assert.equal(r.successRate, null, '0% 会被误读成"全失败了"');
  });
});

describe('工具统计', () => {
  it('按次数排序取前几个', () => {
    const r = buildUsageReport(
      mk({
        effects: [
          { tool: 'read_file', target: 'a', state: 'succeeded', createdAt: now - DAY },
          { tool: 'read_file', target: 'a', state: 'succeeded', createdAt: now - DAY },
          { tool: 'edit_file', target: 'a', state: 'succeeded', createdAt: now - DAY },
        ],
      }),
    );
    assert.equal(r.topTools[0]?.name, 'read_file');
    assert.equal(r.topTools[0]?.count, 2);
  });
});

describe('失败归类', () => {
  it('**没人想读原始错误，要归类**', () => {
    assert.equal(categorizeFailure('ENOENT: no such file'), '文件/路径不存在');
    assert.equal(categorizeFailure('EACCES: permission denied'), '权限问题');
    assert.equal(categorizeFailure('timeout of 30000ms exceeded'), '超时');
    assert.equal(categorizeFailure('命令里含写操作已被拦截'), '被沙箱拦住');
    assert.equal(categorizeFailure('危险动作未获批准'), '审批未通过');
  });

  it('没有原因时明确说没有', () => {
    assert.equal(categorizeFailure(null), '未说明原因');
  });

  it('认不出的归到"其它"', () => {
    assert.equal(categorizeFailure('量子隧穿失败'), '其它');
  });
});

describe('很久没动的项目', () => {
  it('**7 天以上没活动才列出来**', () => {
    const r = buildUsageReport(
      mk({
        projects: [
          { name: '活跃', lastActivityAt: now - DAY },
          { name: '冷掉', lastActivityAt: now - 30 * DAY },
        ],
      }),
    );
    assert.equal(r.staleProjects.length, 1);
    assert.equal(r.staleProjects[0]?.name, '冷掉');
    assert.equal(r.staleProjects[0]?.daysSince, 30);
  });
});

describe('反复改同一个目标', () => {
  it('5 次以上才提示', () => {
    const effects = Array.from({ length: 6 }, (_, i) => ({
      tool: 'edit_file',
      target: 'hot.txt',
      state: 'succeeded',
      createdAt: now - DAY + i * 1000,
    }));
    const r = buildUsageReport(mk({ effects }));
    assert.equal(r.repeatedTargets.length, 1);
    assert.equal(r.repeatedTargets[0]?.count, 6);
  });

  it('改动少的不提示（没有意义）', () => {
    const effects = Array.from({ length: 3 }, (_, i) => ({
      tool: 'edit_file',
      target: 'ok.txt',
      state: 'succeeded',
      createdAt: now - DAY + i * 1000,
    }));
    assert.equal(buildUsageReport(mk({ effects })).repeatedTargets.length, 0);
  });

  it('读操作不算（只关心写）', () => {
    const effects = Array.from({ length: 10 }, (_, i) => ({
      tool: 'read_file',
      target: 'a.txt',
      state: 'succeeded',
      createdAt: now - DAY + i * 1000,
    }));
    assert.equal(buildUsageReport(mk({ effects })).repeatedTargets.length, 0);
  });
});

describe('渲染', () => {
  it('**空的时候明确说没任务**，不是一片空白', () => {
    assert.match(renderUsage(buildUsageReport(mk())), /还没有派过任务/);
  });

  it('带上时间段', () => {
    const text = renderUsage(buildUsageReport(mk({ days: 30 })));
    assert.match(text, /最近 30 天/);
  });
});
