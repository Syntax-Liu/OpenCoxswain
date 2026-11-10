import { useState, type FormEvent } from 'react';
import type { Project } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';

interface Props {
  submitLabel: string;
  busyLabel: string;
  autoFocus?: boolean;
  onReady: (project: Project) => void;
}

/** 接入仓库表单：首次引导与多项目接入共用。 */
export function ProjectForm({
  submitLabel,
  busyLabel,
  autoFocus = false,
  onReady,
}: Props): JSX.Element {
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
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <label>
        本地 git 仓库路径
        <input
          value={repoPath}
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder="D:\code\my-project"
          autoFocus={autoFocus}
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
      <p className="hint">写入只允许落在该工作目录内；外发默认关闭。</p>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" type="submit" disabled={busy || !repoPath.trim()}>
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}
