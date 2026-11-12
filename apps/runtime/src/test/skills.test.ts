/**
 * Skill 测试。
 *
 * 技能的价值是**按需加载**：目录只占约 20 token，正文调用时才读。
 * 这组测试守三件事：
 * 1. 解析容错（手写 frontmatter 出错的常见情况）
 * 2. 项目级覆盖用户级
 * 3. 目录只含名称和描述，**不含正文**（否则省 token 就没意义了）
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MAX_DESCRIPTION_LENGTH,
  SKILL_NAME_PATTERN,
  loadSkill,
  mergeSkills,
  parseSkillFile,
  renderCatalog,
  scanSkillRoot,
  type SkillSummary,
} from '../skills/index.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-skill-'));
  temps.push(d);
  return d;
}

const summary = (over: Partial<SkillSummary> & { name: string }): SkillSummary => ({
  description: 'desc',
  path: `/x/${over.name}/SKILL.md`,
  source: 'project',
  ...over,
});

describe('SKILL.md 解析', () => {
  it('标准格式', () => {
    const r = parseSkillFile(
      '---\nname: write-tests\ndescription: 按项目约定写测试\n---\n\n# 写测试\n\n用 vitest。',
      'fallback',
    );
    assert.equal(r?.name, 'write-tests');
    assert.equal(r?.description, '按项目约定写测试');
    assert.match(r!.content, /用 vitest/);
  });

  it('**没有 frontmatter 也能用**（用目录名当名字、首行当描述）', () => {
    const r = parseSkillFile('# 标题\n\n这是说明。', 'my-skill');
    assert.equal(r?.name, 'my-skill');
    assert.equal(r?.description, '这是说明。');
  });

  it('名字不合法时转成 kebab-case', () => {
    const r = parseSkillFile('---\nname: Write Tests\n---\nbody', 'fallback');
    assert.equal(r?.name, 'write-tests');
  });

  it('名字全是非法字符时返回 null', () => {
    assert.equal(parseSkillFile('---\nname: "***"\n---\nbody', '***'), null);
  });

  it('描述过长会截断（挤占上下文）', () => {
    const long = 'x'.repeat(500);
    const r = parseSkillFile(`---\nname: a\ndescription: ${long}\n---\nbody`, 'a');
    assert.ok((r?.description.length ?? 0) <= MAX_DESCRIPTION_LENGTH);
    assert.ok(r!.description.endsWith('…'));
  });

  it('支持 when-to-use', () => {
    const r = parseSkillFile('---\nname: a\ndescription: d\nwhen-to-use: 写测试时\n---\nbody', 'a');
    assert.equal(r?.whenToUse, '写测试时');
  });

  it('CRLF 文件也能解析', () => {
    const r = parseSkillFile('---\r\nname: a\r\ndescription: d\r\n---\r\nbody', 'a');
    assert.equal(r?.name, 'a');
  });

  it('引号会被去掉', () => {
    const r = parseSkillFile('---\nname: "a"\ndescription: "带引号"\n---\nbody', 'x');
    assert.equal(r?.description, '带引号');
  });

  it('正文里含 --- 不会误判（只认开头那块）', () => {
    const r = parseSkillFile('---\nname: a\ndescription: d\n---\nbody\n\n---\n\n更多', 'a');
    assert.match(r!.content, /更多/);
  });
});

describe('扫描目录', () => {
  it('**同时支持目录包和平铺文件**', async () => {
    const root = await tmp();
    await mkdir(path.join(root, 'packaged'), { recursive: true });
    await writeFile(
      path.join(root, 'packaged', 'SKILL.md'),
      '---\nname: packaged\ndescription: 目录包\n---\n正文',
      'utf8',
    );
    await writeFile(path.join(root, 'flat.md'), '---\nname: flat\ndescription: 平铺\n---\n正文', 'utf8');

    const found = await scanSkillRoot(root, 'project');
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((s) => s.name).sort(),
      ['flat', 'packaged'],
    );
  });

  it('目录不存在时返回空（不抛异常）', async () => {
    assert.deepEqual(await scanSkillRoot(path.join(await tmp(), 'nope'), 'user'), []);
  });

  it('坏文件被跳过，不影响其它', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'good.md'), '---\nname: good\ndescription: ok\n---\nbody', 'utf8');
    // 文件名合法，但 frontmatter 里的 name 全是非法字符 → 解析应该拒绝它
    await writeFile(path.join(root, 'invalid.md'), '---\nname: "@"\n---\nbody', 'utf8');

    const found = await scanSkillRoot(root, 'project');
    assert.equal(found.length, 1, `应当只剩 1 个，实际：${found.map((s) => s.name).join(',')}`);
    assert.equal(found[0]?.name, 'good');
  });

  it('非 md 文件被忽略', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'notes.txt'), 'x', 'utf8');
    assert.equal((await scanSkillRoot(root, 'project')).length, 0);
  });
});

describe('合并优先级', () => {
  it('**项目级覆盖同名的用户级**', () => {
    const user = [summary({ name: 'a', description: '用户级', source: 'user' })];
    const project = [summary({ name: 'a', description: '项目级', source: 'project' })];

    const merged = mergeSkills([project, user]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.description, '项目级');
  });

  it('不同名字都保留', () => {
    const merged = mergeSkills([
      [summary({ name: 'a' })],
      [summary({ name: 'b', source: 'user' })],
    ]);
    assert.equal(merged.length, 2);
  });

  it('按名字排序（稳定输出）', () => {
    const merged = mergeSkills([[summary({ name: 'z' }), summary({ name: 'a' })]]);
    assert.deepEqual(
      merged.map((s) => s.name),
      ['a', 'z'],
    );
  });

  it('空输入不出错', () => {
    assert.deepEqual(mergeSkills([]), []);
  });
});

describe('目录渲染（省 token 的关键）', () => {
  it('**只含名称和描述，不含正文**', () => {
    const catalog = renderCatalog([summary({ name: 'a', description: '说明' })]);
    assert.match(catalog, /a：说明/);
    assert.match(catalog, /use_skill/);
  });

  it('没有技能时返回空串（不注入空目录）', () => {
    assert.equal(renderCatalog([]), '');
  });

  it('带 whenToUse 时一并渲染', () => {
    const catalog = renderCatalog([summary({ name: 'a', description: 'd', whenToUse: '写测试时' })]);
    assert.match(catalog, /适用：写测试时/);
  });

  it('目录长度远小于正文', () => {
    const longBody = 'x'.repeat(5000);
    const catalog = renderCatalog([summary({ name: 'a', description: '一句话' })]);
    assert.ok(catalog.length < longBody.length / 10);
  });
});

describe('加载完整正文', () => {
  it('读得到正文', async () => {
    const root = await tmp();
    await writeFile(
      path.join(root, 'demo.md'),
      '---\nname: demo\ndescription: d\n---\n\n完整正文在这里',
      'utf8',
    );
    const [skill] = await scanSkillRoot(root, 'project');
    const full = await loadSkill(skill!);
    assert.match(full!.content, /完整正文/);
    // frontmatter 不该出现在正文里
    assert.ok(!full!.content.includes('description:'));
  });

  it('文件被删掉时返回 null 而不是崩', async () => {
    const root = await tmp();
    const file = path.join(root, 'gone.md');
    await writeFile(file, '---\nname: gone\ndescription: d\n---\nbody', 'utf8');
    const [skill] = await scanSkillRoot(root, 'project');
    await rm(file);

    assert.equal(await loadSkill(skill!), null);
  });
});

describe('名称规则', () => {
  it('kebab-case 通过', () => {
    assert.ok(SKILL_NAME_PATTERN.test('write-tests'));
    assert.ok(SKILL_NAME_PATTERN.test('a1-b2'));
  });

  it('大写、空格、下划线不通过', () => {
    assert.ok(!SKILL_NAME_PATTERN.test('Write'));
    assert.ok(!SKILL_NAME_PATTERN.test('a b'));
    assert.ok(!SKILL_NAME_PATTERN.test('a_b'));
  });
});
