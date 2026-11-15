import { useEffect, useState } from 'react';

import type { ApiClient, ProjectDto, SettingsStatus } from '../api.js';
import { ImSettings } from './ImSettings.js';

export interface SettingsDialogProps {
  readonly api: ApiClient;
  readonly status: SettingsStatus;
  /** 可绑定的项目列表（给 IM 通道选）。 */
  readonly projects?: readonly ProjectDto[];
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
  const [closeAction, setCloseAction] = useState<'tray' | 'quit'>('tray');

  // 打开时读一次关闭设置
  useEffect(() => {
    void props.api
      .closeSettings()
      .then((r) => setCloseAction(r.settings.closeAction))
      .catch(() => {
        /* 读不到就保持默认 */
      });
  }, [props.api]);

  const saveCloseAction = async (next: 'tray' | 'quit'): Promise<void> => {
    setCloseAction(next);
    try {
      await props.api.setCloseAction(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

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

        {/* 关闭行为：点窗口 × 时怎么办 */}
        <div className="field-group">
          <h3>关闭窗口时</h3>
          <label className="radio-row">
            <input
              type="radio"
              name="closeAction"
              checked={closeAction === 'tray'}
              onChange={() => void saveCloseAction('tray')}
            />
            <span>
              最小化到系统托盘
              <span className="muted small">（Agent 继续运行）</span>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="closeAction"
              checked={closeAction === 'quit'}
              onChange={() => void saveCloseAction('quit')}
            />
            <span>
              直接退出软件
              <span className="muted small">（有 Agent 在跑时会先提示）</span>
            </span>
          </label>
        </div>

        <div className="modal-actions">
          {props.status.configured && props.status.source === 'file' && (
            <button type="button" className="btn btn--ghost btn--md" onClick={() => void clear()} disabled={busy}>
              清除
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--md" onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary btn--md" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        <ImSettings api={props.api} projects={props.projects ?? []} />
      </div>
    </div>
  );
}
