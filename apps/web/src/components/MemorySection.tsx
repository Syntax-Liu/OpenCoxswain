/**
 * 记忆设置。
 *
 * 记忆分两层，界面上也要分开：
 *   1. **候选**：Agent 提炼出来的、还没生效的记忆。需要用户 accept / dismiss。
 *   2. **已生效**：真正会影响后续对话的记忆。可以遗忘（删除）。
 *
 * 为什么候选要单独审：记忆会进入每轮对话的提示词，
 * 一条错的记忆会持续污染后续所有回答。所以默认不自动生效。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MemoryCandidateDto, ProjectDto } from '../api.js';
import { ApiClient } from '../api.js';

export interface MemorySectionProps {
  readonly projects: readonly ProjectDto[];
  readonly currentProjectId: string | null;
}

const KIND_LABEL: Record<string, string> = {
  profile: '用户偏好',
  project: '项目知识',
  decision: '决策',
  lesson: '教训',
};

interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly source: string;
}

export function MemorySection(props: MemorySectionProps): JSX.Element {
  const api = useState(() => new ApiClient())[0];
  const [projectId, setProjectId] = useState(props.currentProjectId ?? '');
  const [candidates, setCandidates] = useState<readonly MemoryCandidateDto[]>([]);
  const [globalEntries, setGlobalEntries] = useState<readonly Entry[]>([]);
  const [projectEntries, setProjectEntries] = useState<readonly Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (pid: string) => {
      if (!pid) return;
      setBusy(true);
      try {
        const [c, list] = await Promise.all([api.memories(pid), api.memoryList(pid)]);
        setCandidates(c.candidates.filter((x) => x.status === 'pending'));
        setGlobalEntries(list.global);
        setProjectEntries(list.project);
        setLoaded(true);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : '读取失败');
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const decide = async (id: string, accept: boolean): Promise<void> => {
    try {
      if (accept) await api.acceptMemory(id);
      else await api.dismissMemory(id);
      setCandidates((list) => list.filter((c) => c.id !== id));
      // 接受后要重新拉，新记忆会出现在"已生效"里
      if (accept) void load(projectId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '操作失败');
    }
  };

  const forget = async (scope: 'global' | 'project', id: string): Promise<void> => {
    try {
      await api.forgetMemory(projectId, scope, id);
      if (scope === 'global') setGlobalEntries((l) => l.filter((e) => e.id !== id));
      else setProjectEntries((l) => l.filter((e) => e.id !== id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <>
      <div className="settings-field">
        <label htmlFor="set-memory-project">项目</label>
        <select
          id="set-memory-project"
          className="settings-select"
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setLoaded(false);
          }}
        >
          <option value="" disabled>
            选一个项目
          </option>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {!projectId && <p className="settings-hint">先选一个项目，才能看它的记忆</p>}
      {busy && <p className="settings-hint">正在读取…</p>}

      {projectId && loaded && (
        <>
          {/* 候选：需要用户审核 */}
          <div className="settings-field">
            <span className="settings-label">
              待审核的候选（{candidates.length}）
            </span>
            <p className="settings-hint">
              这些是 Agent 提炼出来的记忆，**还没生效**。接受后才会影响后续对话。
            </p>
            {candidates.length === 0 && <p className="settings-hint">没有待审核的</p>}
            {candidates.map((c) => (
              <div className="memory-item" key={c.id}>
                <span className="chip">{KIND_LABEL[c.kind] ?? c.kind}</span>
                <span className="chip">{c.scope === 'global' ? '跨项目' : '本项目'}</span>
                <p className="memory-text">{c.text}</p>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void decide(c.id, true)}
                  >
                    接受
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void decide(c.id, false)}
                  >
                    不要
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 已生效 */}
          <div className="settings-field">
            <span className="settings-label">已生效（{globalEntries.length + projectEntries.length}）</span>
            <p className="settings-hint">
              这些会进入每一轮对话。删掉后不再影响后续回答。
            </p>
            {globalEntries.length + projectEntries.length === 0 && (
              <p className="settings-hint">还没有生效的记忆</p>
            )}
            {[...globalEntries.map((e) => ({ e, scope: 'global' as const })),
              ...projectEntries.map((e) => ({ e, scope: 'project' as const }))].map(
              ({ e, scope }) => (
                <div className="memory-item" key={`${scope}-${e.id}`}>
                  <span className="chip">{KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="chip">{scope === 'global' ? '跨项目' : '本项目'}</span>
                  <p className="memory-text">{e.text}</p>
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void forget(scope, e.id)}
                      title="删除这条记忆"
                    >
                      遗忘
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        </>
      )}

      {msg && <p className="settings-message">{msg}</p>}
    </>
  );
}
