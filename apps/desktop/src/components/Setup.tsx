import { useState, type FormEvent } from 'react';
import type { Project } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';

export function Setup({ onReady }: { onReady: (project: Project) => void }): JSX.Element {
  const [repoPath, setRepoPath] = useState('');
  const [name, setName] = useState('');
  const [allowNetwork, setAllowNetwork] = useState(true);
  const [allowExternalSend, setAllowExternalSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!repoPath.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        path: repoPath.trim(),
        name: name.trim() || undefined,
        allowNetwork,
        allowExternalSend,
      });
      onReady(project);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <div className="setup-card">
        <p className="eyebrow">OpenCoxswain · 舵手</p>
        <h1>接入你的第一个项目</h1>
        <p className="muted">
          舵手只做规划、派单和验收。员工在独立 git worktree 里动手，开工前不会写你的仓库。
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            本地 git 仓库路径
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="D:\code\my-project"
              autoFocus
            />
          </label>
          <label>
            项目名（可选）
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="默认使用目录名"
            />
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={allowNetwork}
              onChange={(event) => setAllowNetwork(event.target.checked)}
            />
            允许员工联网读取资料（不包含外发）
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={allowExternalSend}
              onChange={(event) => setAllowExternalSend(event.target.checked)}
            />
            允许员工向外部发送消息（每次仍需审批，且不可撤销）
          </label>
          <p className="hint">
            授权边界：写入只允许落在该工作目录内；外发默认关闭。
          </p>
          {error ? <p className="error">{error}</p> : null}
          <button className="primary" type="submit" disabled={busy || !repoPath.trim()}>
            {busy ? '接入中…' : '接入项目'}
          </button>
        </form>
        <p className="hint">需要已存在的 git 仓库；Daemon 只监听 127.0.0.1。</p>
      </div>
    </main>
  );
}
