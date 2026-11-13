import { useState } from 'react';

import type { ApiClient, ModelConfigDto, ProjectDto, SettingsStatus } from '../api.js';
import { ImSettings } from './ImSettings.js';
import { CloseBehaviorSettings } from './CloseBehaviorSettings.js';
import { FontScaleSetting } from './FontScaleSetting.js';
import { shortcutHelp } from '../shortcuts.js';
import { PermissionSettingsPanel } from './PermissionSettingsPanel.js';
import { ModelSettingsPanel } from './ModelSettingsPanel.js';

/**
 * 设置页（独立页面，照 TRAE / DSH 的组织方式）。
 *
 * ```
 * ← 返回应用
 * ┌──────────┬──────────────────────────┐
 * │ 模型      │                          │
 * │ 权限审批  │   选中那一节的内容        │
 * │ 对话与记忆│                          │
 * │ 通用      │                          │
 * └──────────┴──────────────────────────┘
 * ```
 *
 * 为什么从对话框改成独立页面：
 * 设置项已经多到一个弹窗塞不下——模型列表、参数表单、权限档位、
 * 关闭行为、IM 通道、记忆。弹窗里滚动很难用，而且挡住主界面。
 */

export type SettingsSection =
  | 'models'
  | 'permission'
  | 'memory'
  | 'general'
  | 'im';

interface SectionMeta {
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: string;
}

const SECTIONS: readonly SectionMeta[] = [
  { id: 'models', label: '模型', icon: '◈' },
  { id: 'permission', label: '权限审批', icon: '⚿' },
  { id: 'memory', label: '对话与记忆', icon: '◇' },
  { id: 'general', label: '通用', icon: '⚙' },
  { id: 'im', label: '手机通道', icon: '⇄' },
];

export interface SettingsPageProps {
  readonly api: ApiClient;
  readonly status: SettingsStatus;
  readonly projects: readonly ProjectDto[];
  readonly onClose: () => void;
  readonly onSaved: (status: SettingsStatus) => void;
}

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const [section, setSection] = useState<SettingsSection>('models');

  return (
    <div className="settings-page">
      {/* 顶部：返回 + 菜单栏（照 DSH 的样子） */}
      <header className="settings-topbar">
        <button type="button" className="back-btn" onClick={props.onClose}>
          ← 返回应用
        </button>
        <span className="settings-title">设置</span>
      </header>

      <div className="settings-body">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${section === s.id ? ' active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'models' && (
            <ModelSettingsPanel api={props.api} status={props.status} onSaved={props.onSaved} />
          )}
          {section === 'permission' && <PermissionSettingsPanel api={props.api} />}
          {section === 'memory' && <MemorySection api={props.api} projects={props.projects} />}
          {section === 'general' && <GeneralSection api={props.api} status={props.status} />}
          {section === 'im' && (
            <section className="settings-block">
              <h2>手机通道</h2>
              <p className="muted small">
                配好之后，手机上发的话等于对 Assistant 说的话；
                Agent 出结果、需要你批准危险动作时也会推送到手机。
              </p>
              <ImSettings api={props.api} projects={props.projects ?? []} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** 对话与记忆（目前只有记忆提炼的入口，占位说明现状）。 */
function MemorySection(props: { api: ApiClient; projects: readonly ProjectDto[] }): JSX.Element {
  void props.api;
  return (
    <section className="settings-block">
      <h2>对话与记忆</h2>
      <p className="muted small">
        记忆的确认与删除在对话页顶部的「记忆」条里操作——那里能看到每条记忆的来源，
        比设置页更适合做决定。
      </p>
      <div className="settings-readonly">
        <span className="settings-readonly-key">已打开项目</span>
        <span className="settings-readonly-value">{props.projects.length} 个</span>
      </div>
      <p className="muted small">
        记忆文件位置：<code>~/.opencoxswain/memory/</code>
      </p>
    </section>
  );
}

/** 通用：关闭行为 + 密钥存储状态。 */
function GeneralSection(props: { api: ApiClient; status: SettingsStatus }): JSX.Element {
  return (
    <section className="settings-block">
      <h2>通用</h2>
      <FontScaleSetting />
      <CloseBehaviorSettings api={props.api} />

      <h3 className="settings-subhead">键盘快捷键</h3>
      <p className="muted small">
        在界面任意位置可用（输入框里也行）。Esc 按层级关闭：先关命令面板，再关设置。
      </p>
      <div className="shortcut-table">
        {shortcutHelp(false).map((item) => (
          <div key={item.keys} className="shortcut-row">
            <kbd className="shortcut-keys">{item.keys}</kbd>
            <span className="shortcut-action">{item.action}</span>
          </div>
        ))}
      </div>

      <h3 className="settings-subhead">密钥存储</h3>
      <p className="muted small">
        {props.status.storage === 'encrypted'
          ? '模型密钥以 Windows DPAPI 密文存储，由当前用户账户派生——拷到别的机器或别的用户下都解不开。'
          : '当前密钥以明文存储（没有可用的系统加密服务）。建议在打包版里使用。'}
      </p>
      <div className="settings-readonly">
        <span className="settings-readonly-key">密钥来源</span>
        <span className="settings-readonly-value">
          {props.status.source === 'env'
            ? '环境变量'
            : props.status.source === 'file'
              ? '配置文件'
              : '未配置'}
        </span>
      </div>
    </section>
  );
}

/** 供其他地方复用的空模型常量。 */
export const EMPTY_MODEL: ModelConfigDto | null = null;
