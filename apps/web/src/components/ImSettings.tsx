import { useEffect, useState } from 'react';

import type { ApiClient, ImStatusDto, ProjectDto } from '../api.js';
import { Select } from './Select.js';

export interface ImSettingsProps {
  readonly api: ApiClient;
  readonly projects: readonly ProjectDto[];
}

/**
 * Telegram 通道设置。
 *
 * 设计上只做三件事：填 token、选绑定的项目、看状态。
 * **不显示 token**（后端也不回传），避免截图泄漏。
 */
export function ImSettings(props: ImSettingsProps): JSX.Element {
  const [status, setStatus] = useState<ImStatusDto | null>(null);
  const [token, setToken] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void props.api
      .im()
      .then((s) => {
        setStatus(s);
        setProjectId(s.projectId ?? '');
      })
      .catch(() => setError('读不到 IM 配置'));
  }, [props.api]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await props.api.saveIm(token.trim(), projectId || null);
      setStatus(await props.api.im());
      setToken('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    try {
      await props.api.clearIm();
      setStatus(await props.api.im());
      setToken('');
      setProjectId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '清除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="im-settings">
      <h3>手机通道（Telegram）</h3>
      <p className="muted small">
        配好之后，手机上发的话等于对Assistant说的话；Agent出结果、需要你批准危险动作时也会推送到手机。
      </p>

      {status?.status && (
        <p className={status.status.running ? 'notice' : 'form-error'}>
          {status.status.running
            ? `通道运行中，已绑定 ${status.status.boundChats} 个对话`
            : `通道未运行${status.status.lastError ? `：${status.status.lastError}` : ''}`}
        </p>
      )}

      {status?.hasToken && (
        <p className="muted small">
          已配置 token{status.chatIds.length > 0 ? `，绑定 ${status.chatIds.length} 个对话` : '，还没有对话绑定'}。
          重新填写可覆盖。
        </p>
      )}

      <label className="field">
        <span>Bot Token</span>
        <input
          type="password"
          value={token}
          placeholder={status?.hasToken ? '已配置，留空则不修改' : '从 @BotFather 获取'}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <label className="field">
        <span>绑定项目</span>
        <Select
          value={projectId}
          options={[
            { value: '', label: '（未选择）' },
            ...props.projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={setProjectId}
          ariaLabel="绑定项目"
        />
      </label>

      {status && status.chatIds.length === 0 && status.hasToken && (
        <p className="muted small">
          配好后，用手机给机器人发任意一条消息即可自动完成绑定。
        </p>
      )}

      {error && <p className="form-error">{error}</p>}
      {saved && <p className="notice">已保存。发一条消息给机器人试试。</p>}

      <div className="modal-actions">
        {status?.hasToken && (
          <button type="button" className="btn btn--ghost btn--md" onClick={() => void clear()} disabled={busy}>
            清除
          </button>
        )}
        <button type="button" className="btn btn--primary btn--md" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存通道设置'}
        </button>
      </div>
    </section>
  );
}
