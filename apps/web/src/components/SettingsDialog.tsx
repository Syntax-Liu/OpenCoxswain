import { useState } from 'react';

import type { ApiClient, SettingsStatus } from '../api.js';

export interface SettingsDialogProps {
  readonly api: ApiClient;
  readonly status: SettingsStatus;
  readonly onClose: () => void;
  readonly onSaved: (status: SettingsStatus) => void;
}

/**
 * 模型密钥设置。
 *
 * 桌面应用双击启动时没有终端，用户没法用环境变量配密钥，
 * 所以必须有一个界面能填。保存后**立即生效**，不需要重启。
 *
 * 密钥只在保存时报给本机运行时（落到 `~/.opencoxswain/llm.json`），
 * 界面上不回显已有密钥。
 */
export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(props.status.baseUrl);
  const [model, setModel] = useState(props.status.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) {
      setError('请填写 API Key');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await props.api.saveSettings({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      });
      props.onSaved(next);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await props.api.clearSettings();
      props.onSaved(next);
      setApiKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '清除失败');
    } finally {
      setBusy(false);
    }
  };

  const fromEnv = props.status.source === 'env';

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>模型密钥</h2>
        <p className="muted small">
          自研运行时不依赖外部 Agent 软件，但需要一个 OpenAI 兼容的模型端点。
          密钥只保存在本机。
        </p>

        {fromEnv && (
          <p className="notice">
            当前使用的是环境变量里的密钥。在下面保存会覆盖它——但环境变量优先级更高，
            如需改用这里的设置，请先清除环境变量。
          </p>
        )}

        <label className="field">
          <span>API Key</span>
          <input
            autoFocus
            type="password"
            value={apiKey}
            placeholder={props.status.configured ? '已配置，重新填写可覆盖' : 'sk-...'}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </label>

        <label className="field">
          <span>端点（可选）</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>

        <label className="field">
          <span>模型（可选）</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {props.status.configured && props.status.source === 'file' && (
            <button type="button" className="ghost" onClick={() => void clear()} disabled={busy}>
              清除
            </button>
          )}
          <button type="button" className="ghost" onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
