import type { Project } from '@opencoxswain/shared';
import { ProjectForm } from './ProjectForm.js';

export function Setup({ onReady }: { onReady: (project: Project) => void }): JSX.Element {
  return (
    <main className="setup">
      <div className="setup-card">
        <p className="eyebrow">OpenCoxswain · 舵手</p>
        <h1>接入你的第一个项目</h1>
        <p className="muted">
          舵手只做规划、派单和验收。员工在独立 git worktree 里动手，开工前不会写你的仓库。
        </p>
        <ol className="steps">
          <li>接入一个本地 git 仓库（需要至少一次提交）</li>
          <li>对总管说一句你想完成的事，它会生成任务单</li>
          <li>看过执行清单后点「确认开工」，员工才开始动手</li>
        </ol>
        <ProjectForm submitLabel="接入项目" busyLabel="接入中…" autoFocus onReady={onReady} />
        <p className="hint">Daemon 只监听 127.0.0.1；接入失败会在表单下方说明原因。</p>
      </div>
    </main>
  );
}
