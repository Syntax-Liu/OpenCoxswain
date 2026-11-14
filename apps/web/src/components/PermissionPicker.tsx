/**
 * 输入框里的权限选择器（照 DSH）。
 *
 * ## 用户反馈
 *
 * > 把权限设置放对话框里，就像 DSH 这样，可以随时设置
 *
 * DSH 的输入框左下角有一个「⊙ 完全权限 ⌄」，点开是四档：
 * 仅可查看 / 手动审批 / 自动审批 / 完全权限。
 *
 * 我们之前只能进设置页改，改完还要回来，很别扭。
 *
 * ## 权限语义（不变）
 *
 * - `readonly` 只收紧：只读，不写盘
 * - `auto` / `full` 跳过询问，但**副作用台账照记**
 *
 * 这个组件只负责切换，不改任何权限判定逻辑。
 */
import { useEffect, useRef, useState } from 'react';

import type { ApiClient, PermissionLevelDto } from '../api.js';
import { IconCheck, IconChevron, IconShield } from './icons.js';

export interface PermissionPickerProps {
  readonly api: ApiClient;
  /**
   * **哪个项目的权限**。
   *
   * 用户要求：每个项目独立设置，改一个不影响其他项目。
   * 不传就等于没进项目（用全局默认）。
   */
  readonly projectId?: string;
  /** 权限变了之后通知外层（有些操作要重新拉状态）。 */
  readonly onChange?: (level: string) => void;
}

export function PermissionPicker(props: PermissionPickerProps): JSX.Element | null {
  const [levels, setLevels] = useState<readonly PermissionLevelDto[]>([]);
  const [current, setCurrent] = useState('manual');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 拉一次档位和当前值
  useEffect(() => {
    let alive = true;
    props.api
      .permissions(props.projectId)
      .then((r) => {
        if (!alive) return;
        setLevels(r.levels);
        // 接口返回 settings.effective = 这个项目实际生效的档位
        setCurrent(r.settings.effective ?? r.settings.level);
      })
      .catch(() => {
        /* 拉不到就只显示"权限"两个字，不报错 */
      });
    return () => {
      alive = false;
    };
    // 项目变了要重新拉——每个项目的档位不同
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (levels.length === 0) return null;

  const active = levels.find((l) => l.id === current);

  const choose = async (id: string): Promise<void> => {
    if (id === current || busy) { setOpen(false); return; }
    setBusy(true);
    setError(null);
    try {
      await props.api.setPermissionLevel(id, props.projectId);
      setCurrent(id);
      setOpen(false);
      props.onChange?.(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '切换失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="perm-picker" ref={ref}>
      <button
        type="button"
        className="composer-chip perm-picker-btn"
        onClick={() => setOpen((v) => !v)}
        title={active?.hint ?? '权限'}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <IconShield size={14} />
        <span className="perm-picker-label">{active?.label ?? '权限'}</span>
        <IconChevron size={12} direction={open ? 'down' : 'right'} />
      </button>

      {open && (
        <ul className="perm-picker-menu" role="listbox">
          {levels.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                role="option"
                aria-selected={l.id === current}
                className={`perm-picker-item${l.id === current ? ' active' : ''}`}
                onClick={() => void choose(l.id)}
                disabled={busy}
              >
                <span className="perm-picker-check">{l.id === current && <IconCheck size={14} />}</span>
                <span className="perm-picker-item-body">
                  <span className="perm-picker-item-label">{l.label}</span>
                  <span className="perm-picker-item-hint">{l.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <span className="perm-picker-error">{error}</span>}
    </div>
  );
}
