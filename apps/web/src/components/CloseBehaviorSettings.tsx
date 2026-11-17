import { useEffect, useState } from 'react';

import type { ApiClient } from '../api.js';
import { TextInput } from '../ui/index.js';

/**
 * 关闭行为设置面板。
 *
 * 从 SettingsDialog 里抽出来，两个入口（设置页 / 旧对话框）共用。
 */
export function CloseBehaviorSettings(props: { api: ApiClient }): JSX.Element {
  const [action, setAction] = useState<'tray' | 'quit'>('tray');
  const [running, setRunning] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void props.api
      .closeSettings()
      .then((r) => {
        setAction(r.settings.closeAction);
        setRunning(r.running);
      })
      .catch(() => {
        /* 读不到保持默认 */
      });
  }, [props.api]);

  const choose = async (next: 'tray' | 'quit'): Promise<void> => {
    setAction(next);
    try {
      await props.api.setCloseAction(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

  return (
    <div className="settings-group">
      <h3 className="settings-subhead">关闭窗口时</h3>
      <label className="radio-row">
        <TextInput type="radio"
          name="closeAction"
          checked={action === 'tray'}
          onChange={() => void choose('tray')} />
        <span>
          最小化到系统托盘
          <span className="muted small">（Agent 继续运行）</span>
        </span>
      </label>
      <label className="radio-row">
        <TextInput type="radio"
          name="closeAction"
          checked={action === 'quit'}
          onChange={() => void choose('quit')} />
        <span>
          直接退出软件
          <span className="muted small">
            （{running > 0 ? `当前有 ${running} 个 Agent 在跑，退出前会提示` : '有 Agent 在跑时会先提示'}）
          </span>
        </span>
      </label>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
