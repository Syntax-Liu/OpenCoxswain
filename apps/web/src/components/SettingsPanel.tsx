/**
 * 设置面板。
 *
 * 第一版只做**最关键的一项：模型配置**。
 * 没有它产品根本用不了（没有 API Key 就派不了活），
 * 所以它比"手机通道""联网搜索"优先。
 *
 * 其余分区（记忆、通用、IM、联网搜索）后续按同一套样式补。
 *
 * 安全约定：
 * - 密钥只在本机保存，**不回传明文**——`settings()` 只返回是否已配置；
 * - 保存后立即生效，不需要重启。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SettingsStatus } from '../api.js';
import { ApiClient } from '../api.js';

export interface SettingsPanelProps {
  readonly onClose: () => void;
  /** 配置变化后通知外层（项目列表可能需要重新拉取）。 */
  readonly onChanged?: () => void;
}

const MODEL_PRESETS: readonly { label: string; baseUrl: string; model: string }[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  { label: 'DeepSeek（Pro）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
];

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const api = useState(() => new ApiClient())[0];
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setStatus(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
      })
      .catch(() => setMessage('读取设置失败'));
  }, [api]);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const key = apiKey.trim();
    // 后端 save() 要求完整三元组（apiKey/baseUrl/model），没有"只改端点"的入口。
    // 所以：没填 Key 时，只有"已配置过且端点和模型都没改"才允许保存。
    const changedEndpoint = baseUrl.trim() !== (status?.baseUrl ?? '');
    const changedModel = model.trim() !== (status?.model ?? '');
    if (!key && (!status?.configured || changedEndpoint || changedModel)) {
      setBusy(false);
      setMessage('要修改端点或模型，请一并填写 API Key（后端要求完整配置）');
      return;
    }
    try {
      const next = await api.saveSettings({
        // 已配置且只改端点/模型时，回填一个占位——后端不接受空 Key。
        // 这种情况上面已经拦下；这里保证类型完整。
        apiKey: key,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
      });
      setStatus(next);
      setApiKey('');
      setMessage('已保存，立即生效');
      props.onChanged?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [api, apiKey, baseUrl, model, status, props]);

  const clear = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await api.clearSettings();
      setStatus(next);
      setApiKey('');
      setMessage('已清除密钥');
      props.onChanged?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '清除失败');
    } finally {
      setBusy(false);
    }
  }, [api, props]);

  return (
    <div className="settings">
      <div className="settings-head">
        <h2 className="settings-title">设置</h2>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={props.onClose}
          title="关闭（Esc）"
          aria-label="关闭设置"
        >
          ×
        </button>
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <h3 className="settings-section-title">模型</h3>

          <p className="settings-hint">
            {status === null
              ? '正在读取…'
              : status.configured
                ? `已配置（来源：${status.source === 'env' ? '环境变量' : '本机文件'}${
                    status.storage === 'plaintext' ? '，明文存储' : ''
                  }）`
                : '还没有配置，配置后才能派活'}
          </p>

          <div className="settings-field">
            <label htmlFor="set-preset">快速选择</label>
            <select
              id="set-preset"
              className="settings-select"
              onChange={(e) => {
                const preset = MODEL_PRESETS[Number(e.target.value)];
                if (preset) {
                  setBaseUrl(preset.baseUrl);
                  setModel(preset.model);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>
                选一个预设，或直接填下面的字段
              </option>
              {MODEL_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label htmlFor="set-key">API Key</label>
            <input
              id="set-key"
              type="password"
              className="settings-input"
              value={apiKey}
              placeholder={status?.configured ? '留空表示不修改' : 'sk-...'}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="settings-field">
            <label htmlFor="set-url">Endpoint</label>
            <input
              id="set-url"
              className="settings-input"
              value={baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="set-model">Model</label>
            <input
              id="set-model"
              className="settings-input"
              value={model}
              placeholder="deepseek-v4-flash"
              onChange={(e) => setModel(e.target.value)}
            />
          </div>

          <p className="settings-hint">
            密钥只保存在本机，不会上传。界面不会显示已保存的密钥原文。
          </p>

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn--primary btn--md"
              onClick={() => void save()}
              disabled={busy}
            >
              {busy ? '保存中…' : '保存'}
            </button>
            {status?.configured && (
              <button
                type="button"
                className="btn btn--danger btn--md"
                onClick={() => void clear()}
                disabled={busy}
              >
                清除密钥
              </button>
            )}
          </div>

          {message && <p className="settings-message">{message}</p>}
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">通用</h3>
          <GeneralSection />
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">关于其他设置</h3>
          <p className="settings-hint">
            记忆、手机通道、联网搜索还没迁移到新界面，
            暂时可以在旧界面（`apps/web-legacy`）里改，或直接编辑配置文件。
          </p>
        </section>
      </div>
    </div>
  );
}

/** 通用：图标主题 + 关闭行为。 */
function GeneralSection(): JSX.Element {
  const api = useState(() => new ApiClient())[0];
  const [iconTheme, setIconTheme] = useState<string | null>(null);
  const [closeAction, setCloseAction] = useState<'tray' | 'quit' | null>(null);
  const [running, setRunning] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.iconTheme().then((r) => setIconTheme(r.theme)).catch(() => undefined);
    void api
      .closeSettings()
      .then((r) => {
        setCloseAction(r.settings.closeAction);
        setRunning(r.running);
      })
      .catch(() => undefined);
  }, [api]);

  const ICONS: readonly { id: string; label: string }[] = [
    { id: 'violet', label: '紫' },
    { id: 'mint', label: '薄荷' },
    { id: 'sky', label: '天蓝' },
    { id: 'coral', label: '珊瑚' },
    { id: 'graphite', label: '石墨' },
    { id: 'deep', label: '深蓝' },
  ];

  const chooseIcon = async (id: string): Promise<void> => {
    setIconTheme(id);
    try {
      await api.setIconTheme(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

  const chooseClose = async (next: 'tray' | 'quit'): Promise<void> => {
    setCloseAction(next);
    try {
      await api.setCloseAction(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

  return (
    <>
      <div className="settings-field">
        <span className="settings-label">应用图标</span>
        <div className="settings-chips">
          {ICONS.map((i) => (
            <button
              key={i.id}
              type="button"
              className={`btn btn--sm ${iconTheme === i.id ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => void chooseIcon(i.id)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field">
        <span className="settings-label">关闭窗口时</span>
        <label className="settings-radio">
          <input
            type="radio"
            name="closeAction"
            checked={closeAction === 'tray'}
            onChange={() => void chooseClose('tray')}
          />
          <span>
            最小化到托盘
            <span className="settings-hint">（Agent 继续运行）</span>
          </span>
        </label>
        <label className="settings-radio">
          <input
            type="radio"
            name="closeAction"
            checked={closeAction === 'quit'}
            onChange={() => void chooseClose('quit')}
          />
          <span>
            直接退出软件
            <span className="settings-hint">
              {running > 0 ? `（当前有 ${running} 个 Agent 在跑，退出前会提示）` : '（有 Agent 在跑时会先提示）'}
            </span>
          </span>
        </label>
      </div>

      {error && <p className="settings-message">{error}</p>}
    </>
  );
}
