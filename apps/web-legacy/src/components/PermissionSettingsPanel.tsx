import { useEffect, useState } from 'react';

import type { ApiClient } from '../api.js';

/** 权限档位面板。 */
export function PermissionSettingsPanel(props: { api: ApiClient }): JSX.Element {
  const [levels, setLevels] = useState<
    Array<{ id: string; label: string; hint: string }>
  >([]);
  const [current, setCurrent] = useState<string>('manual');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void props.api
      .permissions()
      .then((r) => {
        setLevels([...r.levels]);
        setCurrent(r.settings.level);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '读不到权限设置'));
  }, [props.api]);

  const choose = async (level: string): Promise<void> => {
    setBusy(true);
    try {
      await props.api.setPermissionLevel(level);
      setCurrent(level);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-block">
      <h2>权限审批</h2>
      <p className="muted small">
        决定 Agent 能做什么、什么时候要问你。<strong>改完立即生效</strong>，
        对正在跑的 Agent 也适用。
      </p>

      <div className="perm-list">
        {levels.map((level) => (
          <label key={level.id} className={`perm-row${current === level.id ? ' active' : ''}`}>
            <input
              type="radio"
              name="permission"
              checked={current === level.id}
              disabled={busy}
              onChange={() => void choose(level.id)}
            />
            <span className="perm-text">
              <span className="perm-label">{level.label}</span>
              <span className="perm-hint">{level.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <p className="notice">
        无论哪一档，<strong>副作用台账都会记录</strong>——放行的是「要不要问你」，
        不是「要不要留痕」。写域互斥、跨项目冲突、用量止损在任何档位下都生效。
      </p>

      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
