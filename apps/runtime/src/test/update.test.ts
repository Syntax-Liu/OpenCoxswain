/**
 * 更新检查测试。
 *
 * 只测运行时侧能确定的部分：读文件、版本比较、摘要文案。
 * **真实更新链路（下载、签名校验、替换）需要打包并发布到 GitHub 才能验证，
 * 这里不假装测过。**
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { compareVersions, readUpdateCheck, summaryLine } from '../update/check.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmpFile(content?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-update-'));
  temps.push(dir);
  const file = path.join(dir, 'update-check.json');
  if (content !== undefined) await writeFile(file, content, 'utf8');
  return file;
}

describe('版本比较', () => {
  it('判断新版更大', () => {
    assert.ok(compareVersions('0.7.0', '0.6.0') > 0);
    assert.ok(compareVersions('0.6.1', '0.6.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  });

  it('相同版本为 0', () => {
    assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
    assert.equal(compareVersions('v0.6.0', '0.6.0'), 0, '允许带 v 前缀');
  });

  it('旧版更小', () => {
    assert.ok(compareVersions('0.5.0', '0.6.0') < 0);
  });

  it('位数不同也能比（0.6 vs 0.6.1）', () => {
    assert.ok(compareVersions('0.6', '0.6.1') < 0);
  });
});

describe('读取更新结果', () => {
  it('读有新版本的结果', async () => {
    const file = await tmpFile(
      JSON.stringify({
        available: true,
        version: '0.7.0',
        notes: '修了几个问题',
        currentVersion: '0.6.0',
        checkedAt: 1700000000000,
      }),
    );
    const check = await readUpdateCheck(file);
    assert.equal(check?.available, true);
    assert.equal(check?.version, '0.7.0');
  });

  it('读"已是最新"的结果', async () => {
    const file = await tmpFile(JSON.stringify({ available: false, currentVersion: '0.6.0' }));
    const check = await readUpdateCheck(file);
    assert.equal(check?.available, false);
    assert.equal(check?.version, undefined);
  });

  it('**文件不存在时返回 null**（没查过不是错误）', async () => {
    const file = await tmpFile();
    assert.equal(await readUpdateCheck(file), null);
  });

  it('文件损坏时返回 null，不抛异常', async () => {
    const file = await tmpFile('{ 这不是 JSON');
    assert.equal(await readUpdateCheck(file), null);
  });

  it('缺少 currentVersion 时视为无效', async () => {
    const file = await tmpFile(JSON.stringify({ available: true, version: '9.9.9' }));
    assert.equal(await readUpdateCheck(file), null);
  });
});

describe('摘要文案', () => {
  it('有新版时显示版本号', () => {
    const text = summaryLine({
      available: true,
      version: '0.7.0',
      currentVersion: '0.6.0',
      checkedAt: 0,
    });
    assert.match(text, /有新版本 0\.7\.0/);
    assert.match(text, /0\.6\.0/);
  });

  it('无新版时说已是最新', () => {
    const text = summaryLine({ available: false, currentVersion: '0.6.0', checkedAt: 0 });
    assert.match(text, /已是最新/);
  });
});
