/**
 * 新会话的项目选择器（照 DSH）。
 *
 * ## 背景
 *
 * 用户指出："新会话"和"添加项目"**作用完全一样**——两处都绑同一个
 * `onOpenProject`，点了都是弹"打开项目"对话框。
 *
 * DSH 的分工是：
 *
 *     新会话    → 进空对话页，**在输入框旁边选项目**（图一的 📁 OpenCoxswain ▾）
 *     项目列表  → 点项目名进该项目的 Assistant
 *
 * 也就是说"新建/打开项目"不再是顶部的导航项，而是**新会话里的一个动作**。
 *
 * ## 这个组件的职责
 *
 * 只负责"选哪个项目"和"新建一个"两项，不负责对话本身。
 */
import { useState } from 'react';

import type { ProjectDto } from '../api.js';
import { IconChevron, IconFolder, IconPlus } from './icons.js';

export interface ProjectPickerProps {
  readonly projects: readonly ProjectDto[];
  readonly currentId?: string;
  /** 选中已有项目。 */
  readonly onPick: (projectId: string) => void;
  /** 新建/打开一个项目（走原来的"打开项目"对话框）。 */
  readonly onCreate: () => void;
}

export function ProjectPicker(props: ProjectPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = props.projects.find((p) => p.id === props.currentId);

  return (
    <div className="project-picker">
      <button
        type="button"
        className="btn btn--ghost btn--sm project-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <IconFolder size={14} />
        <span className="project-picker-name">{current ? current.name : '选择项目'}</span>
        <IconChevron size={12} direction={open ? 'down' : 'right'} />
      </button>

      {open && (
        <ul className="project-picker-menu" role="listbox">
          {props.projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={p.id === props.currentId}
                className={`project-picker-item${p.id === props.currentId ? ' active' : ''}`}
                onClick={() => {
                  setOpen(false);
                  props.onPick(p.id);
                }}
              >
                <IconFolder size={14} />
                <span className="project-picker-item-name">{p.name}</span>
                <span className="project-picker-item-path" title={p.displayPath}>
                  {p.displayPath}
                </span>
              </button>
            </li>
          ))}
          <li className="project-picker-sep" role="separator" />
          <li>
            <button
              type="button"
              className="project-picker-item project-picker-create"
              onClick={() => {
                setOpen(false);
                props.onCreate();
              }}
            >
              <IconPlus size={14} />
              <span>打开或新建项目</span>
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
