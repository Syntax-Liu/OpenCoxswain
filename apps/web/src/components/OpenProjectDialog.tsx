import { useState } from 'react';

export interface OpenProjectDialogProps {
  readonly onCancel: () => void;
  readonly onConfirm: (rootPath: string, name?: string) => void;
}

/** 打开项目：只问路径与可选显示名。 */
export function OpenProjectDialog(props: OpenProjectDialogProps): JSX.Element {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');

  const submit = (): void => {
    const path = rootPath.trim();
    if (!path) return;
    props.onConfirm(path, name.trim() || undefined);
  };

  return (
    <div className="modal-backdrop" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>打开项目</h2>
        <p className="muted small">
          填入项目根目录的绝对路径。每个项目的项目经理会记住自己的上下文。
        </p>

        <label className="field">
          <span>项目路径</span>
          <input
            autoFocus
            value={rootPath}
            placeholder="D:\work\my-app"
            onChange={(e) => setRootPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>

        <label className="field">
          <span>显示名（可选）</span>
          <input
            value={name}
            placeholder="缺省取路径最后一段"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={props.onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={submit} disabled={!rootPath.trim()}>
            打开
          </button>
        </div>
      </div>
    </div>
  );
}
