/**
 * 命令面板（Ctrl+K）。
 *
 * 为什么需要：新界面取消了左栏，项目切换在头部下拉里——
 * 项目一多就不好找。命令面板是"没有侧栏"的必要补偿。
 *
 * 提供：切项目、打开 Agent、打开设置。
 * 不做：模糊搜索太重，用子串匹配 + 首字母排序就够了。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExecutorDto, ProjectDto } from '../api.js';

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly group: string;
  readonly run: () => void;
}

export interface CommandPaletteProps {
  readonly projects: readonly ProjectDto[];
  readonly executors: readonly ExecutorDto[];
  readonly onClose: () => void;
  readonly onPickProject: (id: string) => void;
  readonly onOpenExecutor: (id: string) => void;
  readonly onOpenSettings: () => void;
  /** 在侧边栏打开浏览器。 */
  readonly onOpenBrowser?: () => void;
}

export function buildCommands(props: CommandPaletteProps): readonly Command[] {
  const cmds: Command[] = [];
  for (const p of props.projects) {
    cmds.push({
      id: `project:${p.id}`,
      label: p.name,
      hint: p.rootPath,
      group: '项目',
      run: () => props.onPickProject(p.id),
    });
  }
  for (const e of props.executors) {
    cmds.push({
      id: `executor:${e.id}`,
      label: e.label,
      hint: e.status === 'running' ? '正在执行' : e.status,
      group: 'Agent',
      run: () => props.onOpenExecutor(e.id),
    });
  }
  cmds.push({
    id: 'settings',
    label: '打开设置',
    group: '操作',
    run: () => props.onOpenSettings(),
  });
  if (props.onOpenBrowser) {
    cmds.push({
      id: 'browser',
      label: '打开浏览器',
      hint: '侧边栏',
      group: '操作',
      run: () => props.onOpenBrowser?.(),
    });
  }
  return cmds;
}

/** 子串匹配（不区分大小写）。 */
export function filterCommands(
  commands: readonly Command[],
  query: string,
): readonly Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      (c.hint ?? '').toLowerCase().includes(q),
  );
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => buildCommands(props), [props]);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const runAt = (i: number): void => {
    const cmd = filtered[i];
    if (!cmd) return;
    cmd.run();
    props.onClose();
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="命令面板">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="搜索项目、Agent 或操作"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              props.onClose();
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              runAt(index);
            }
          }}
        />

        <div className="palette-list" role="listbox">
          {filtered.length === 0 && <p className="palette-empty">没有匹配项</p>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === index}
              className={`palette-item${i === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runAt(i)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
