/**
 * 用户这一轮的反馈。
 *
 * ## 1. 权限设置从设置页删除
 *
 * > 我说了把权限放对话框里，就把设置里面的删掉呀，留着给谁用呢？
 *
 * 两处入口是**矛盾**的：同一份状态两个地方能改，用户不知道哪个算数。
 *
 * ## 2. 权限按项目独立
 *
 * > 每个项目都要有独立的权限设置，在一个项目改变权限设置，
 *   只改变当前项目的设置，不影响其他的项目
 *
 * 之前 `PermissionSettings` 只有全局 `level`，改一次全平台生效——
 * 在 A 项目放行「完全权限」，B 项目也跟着放行了。
 *
 * ## 3. 不再有浏览器原生 `<select>`
 *
 * > 这个白块是什么鬼？你把所有控件整合到一起，
 *   把作用相似的控件设计整合，而不是开一堆风格不统一的UI
 *
 * 原生 `<select>` 的弹出层、箭头、高亮色全由操作系统决定，
 * 和深色界面割裂，CSS 改不动。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const settingsPage = readFileSync(new URL('../../src/components/SettingsPage.tsx', import.meta.url), 'utf8');
const permissionTs = readFileSync(new URL('../../../runtime/src/settings/permission.ts', import.meta.url), 'utf8');
const orchestrator = readFileSync(new URL('../../../runtime/src/orchestrator.ts', import.meta.url), 'utf8');
const serverTs = readFileSync(new URL('../../../runtime/src/server/server.ts', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../src/api.ts', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../../src/components/PermissionPicker.tsx', import.meta.url), 'utf8');
const modelPanel = readFileSync(new URL('../../src/components/ModelSettingsPanel.tsx', import.meta.url), 'utf8');
const imSettings = readFileSync(new URL('../../src/components/ImSettings.tsx', import.meta.url), 'utf8');

describe('**1. 权限只在一个地方改**', () => {
  it('设置页没有权限分区', () => {
    assert.doesNotMatch(settingsPage, /'permission'/, '设置页不该再有权限入口');
    assert.doesNotMatch(settingsPage, /PermissionSettingsPanel/);
  });

  it('设置页侧栏只剩四项', () => {
    const sections = [...settingsPage.matchAll(/\{ id: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]);
    assert.deepEqual(sections, ['模型', '对话与记忆', '通用', '手机通道']);
  });

  it('输入框里有权限选择器', () => {
    assert.match(picker, /export function PermissionPicker/);
  });
});

describe('**2. 权限按项目独立**', () => {
  it('PermissionSettings 有 projects 字段', () => {
    assert.match(permissionTs, /readonly projects: Readonly<Record<string, PermissionLevel>>/);
  });

  it('有 levelForProject 解析函数', () => {
    assert.match(permissionTs, /export function levelForProject/);
    // 没设过的项目回退到全局默认
    assert.match(permissionTs, /settings\.projects\[projectId\] \?\? settings\.level/);
  });

  it('setPermissionLevel 接受 projectId', () => {
    assert.match(orchestrator, /setPermissionLevel\(level: PermissionLevel, projectId\?: string \| null\)/);
  });

  it('**改一个项目只写那个项目的字段**', () => {
    assert.match(
      orchestrator,
      /projects: \{ \.\.\.s\.projects, \[projectId\]: level \}/,
      '不能覆盖整个 projects 表',
    );
  });

  it('server 支持 ?project= 查询参数', () => {
    assert.match(serverTs, /url\.searchParams\.get\('project'\)/);
  });

  it('前端 api 传 projectId', () => {
    assert.match(api, /permissions\(projectId\?: string\)/);
    assert.match(api, /setPermissionLevel\(level: string, projectId\?: string \| null\)/);
  });

  it('选择器按项目拉和改', () => {
    assert.match(picker, /permissions\(props\.projectId\)/);
    assert.match(picker, /setPermissionLevel\(id, props\.projectId\)/);
  });

  it('项目变了重新拉档位', () => {
    assert.match(picker, /\}, \[props\.projectId\]\)/);
  });
});

describe('**3. 没有浏览器原生 select**', () => {
  it('模型设置里没有原生 select', () => {
    assert.doesNotMatch(modelPanel, /<select/, '原生 select 的下拉层无法统一风格');
  });

  it('IM 设置里没有原生 select', () => {
    assert.doesNotMatch(imSettings, /<select/);
  });

  it('用的是统一的 Select 组件', () => {
    assert.match(modelPanel, /from '\.\/Select\.js'/);
    assert.match(imSettings, /from '\.\/Select\.js'/);
  });
});
