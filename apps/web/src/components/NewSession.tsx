/**
 * 新会话页：**还没有选项目**。
 *
 * ## 为什么需要
 *
 * 用户原话：
 * > "新会话"和"添加项目"这两个的作用是一样的，只保留"新会话"，
 * > 然后在对话框附近选择项目
 *
 * 以前点「新会话」直接跳第一个项目的 Assistant，用户没法选。
 * 现在进这个页面：选项目是**决定下一步做什么**，而不是"打开某个项目"。
 *
 * ## 和主对话的关系
 *
 * 结构照主对话（`.composer > .composer-box > textarea + .composer-bar`），
 * 只是输入框上面多一个项目选择器，选完才进真正的对话。
 */
import { useState } from 'react';

import type { ProjectDto } from '../api.js';
import { IconSend, IconSidebar } from './icons.js';
import { AppIcon } from './AppIcon.js';
import { ProjectPicker } from './ProjectPicker.js';
import { IconButton, SendButton, Textarea } from '../ui/index.js';

export interface NewSessionProps {
  /** 应用图标配色（用户选的）。不传就用紫罗兰。 */
  readonly iconTheme?: string;
  /** 右侧边栏是否展开（和主对话保持一致）。 */
  readonly railOpen?: boolean;
  /** 切换右侧边栏。 */
  readonly onToggleRail?: () => void;
  readonly projects: readonly ProjectDto[];
  /** 选中项目后进入它的 Assistant。 */
  readonly onPick: (projectId: string) => void;
  /** 打开或新建项目。 */
  readonly onCreate: () => void;
}

export function NewSession(props: NewSessionProps): JSX.Element {
  const iconTheme = props.iconTheme;
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState(false);

  const submit = (): void => {
    // 没选项目时，点发送只是提示——不能"发到一个不存在的项目"
    if (!draft.trim()) return;
    setHint(true);
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <div className="header-main">
          <h2>新会话</h2>
        </div>
        {props.onToggleRail && (
          <div className="header-side">
            <IconButton onClick={props.onToggleRail} aria-pressed={props.railOpen} label={props.railOpen ? '收起侧边栏' : '展开侧边栏'} size="sm" className={`rail-toggle ${props.railOpen ? ' active' : ''}`}><IconSidebar size={16} /></IconButton>
          </div>
        )}
      </header>

      <div className="messages">
        <div className="welcome">
          <div className="welcome-brand">
            <AppIcon size={36} theme={iconTheme} />
            <h1>新会话</h1>
          </div>
          <p className="welcome-sub">
            先选一个项目，再说你想做什么。项目决定我在哪个目录里干活。
          </p>
        </div>
      </div>

      <div className="composer">
        <div className="composer-box">
          <div className="composer-picker-row">
            <ProjectPicker
              projects={props.projects}
              onPick={props.onPick}
              onCreate={props.onCreate}
            />
          </div>

          <Textarea value={draft}
            placeholder="选好项目后，在这里说要做什么"
            onChange={(e) => {
              setDraft(e.target.value);
              if (hint) setHint(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2} />

          <div className="composer-bar">
            <div className="composer-left">
              {hint && <span className="composer-hint-inline">先在上面选一个项目</span>}
            </div>
            {/* **和 Conversation 用同一个按钮**：
                之前这里写的是文字 `↑`、没有图标，
                而主对话用 IconSend —— 两个页面同一个动作长得不一样。 */}
            <SendButton
              onClick={submit}
              disabled={!draft.trim()}
            >
              <IconSend size={16} />
            </SendButton>
          </div>
        </div>
      </div>
    </div>
  );
}
