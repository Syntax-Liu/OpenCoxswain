import { useEffect, useState } from 'react';
import type {
  ArtifactRecord,
  Assistant,
  EventRecord,
  MemoryEntry,
  MemoryKind,
  MemoryMatch,
  MemoryReport,
} from '@opencoxswain/shared';
import { MEMORY_KINDS } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';
import type { SecretsStatus } from '../api.js';
import { DiffReviewView } from '../components/DiffReviewView.js';
import {
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatTime,
  MarkdownLite,
  ROLE_LABELS,
} from '../ui.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function exportEvents(events: EventRecord[], projectId: string): void {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `opencoxswain-events-${projectId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function TimelineTab(): JSX.Element {
  const { events, tasks, project } = useWorkbench();
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  return (
    <div className="timeline-tab">
      <div className="row">
        <button
          className="ghost"
          onClick={() => exportEvents(events, project.id)}
          disabled={events.length === 0}
        >
          导出事件
        </button>
      </div>
      {events.length === 0 ? (
        <p className="placeholder">还没有事件。派单、工具调用、验收都会记录在这里。</p>
      ) : (
        <ol className="timeline">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <time>{formatTime(event.createdAt)}</time>
              <span className="event-type">{event.type}</span>
              <span className="event-task">
                {event.taskId ? taskTitles.get(event.taskId) ?? event.taskId : '项目'}
              </span>
              <details>
                <summary>详情</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ArtifactsTab(): JSX.Element {
  const { artifacts, tasks } = useWorkbench();
  const [selected, setSelected] = useState<ArtifactRecord | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .artifact(selected.id)
      .then((text) => {
        if (alive) setContent(text);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  if (artifacts.length === 0) {
    return <p className="placeholder">员工完成后，diff 与报告会出现在这里。</p>;
  }

  return (
    <div className="artifacts">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            className={selected?.id === artifact.id ? 'artifact active' : 'artifact'}
            onClick={() => setSelected(artifact)}
          >
            <span className="artifact-type">{artifact.type}</span>
            <span className="artifact-name">{artifact.path.split(/[\\/]/).pop()}</span>
            <span className="artifact-task">{taskTitles.get(artifact.taskId) ?? ''}</span>
          </button>
        ))}
      </div>
      <div className="artifact-view">
        {!selected ? <p className="placeholder">选择左侧产物查看内容。</p> : null}
        {loading ? <p className="placeholder">读取中…</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {selected && !loading && !error ? (
          <>
            <header>
              <span>{selected.path}</span>
              <span className="muted">
                {formatDateTime(selected.createdAt)}
                {selected.meta
                  ? ` · ${selected.meta.files ?? 0} 文件 +${selected.meta.additions ?? 0} -${selected.meta.deletions ?? 0}`
                  : ''}
              </span>
            </header>
            {selected.type === 'diff' ? (
              <>
                <DiffReviewView taskId={selected.taskId} />
                <details className="raw-artifact">
                  <summary>原始 patch</summary>
                  <pre>{content}</pre>
                </details>
              </>
            ) : (
              <pre>{content}</pre>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function SummaryTab(): JSX.Element {
  const { summary } = useWorkbench();
  return summary ? (
    <MarkdownLite text={summary} />
  ) : (
    <p className="placeholder">任务开始后在这里生成三块汇总。</p>
  );
}

function CostTab(): JSX.Element {
  const { workers, tasks, project } = useWorkbench();
  const totals = workers.reduce(
    (sum, worker) => ({
      usd: sum.usd + worker.cost.usd,
      tokensIn: sum.tokensIn + worker.cost.tokensIn,
      tokensOut: sum.tokensOut + worker.cost.tokensOut,
      minutes: sum.minutes + worker.cost.minutes,
    }),
    { usd: 0, tokensIn: 0, tokensOut: 0, minutes: 0 },
  );
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  return (
    <div className="cost">
      <div className="cost-summary">
        <div>
          <span>总花费</span>
          <strong>{formatMoney(totals.usd)}</strong>
        </div>
        <div>
          <span>输入 / 输出 tokens</span>
          <strong>
            {totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()}
          </strong>
        </div>
        <div>
          <span>总耗时</span>
          <strong>{formatMinutes(totals.minutes)}</strong>
        </div>
        <div>
          <span>项目日预算</span>
          <strong>{formatMoney(project.dailyBudgetUsd)}</strong>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>员工</th>
            <th>任务</th>
            <th>花费</th>
            <th>tokens</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.id}>
              <td>{ROLE_LABELS[worker.role]}</td>
              <td>{taskTitles.get(worker.taskId) ?? worker.taskId}</td>
              <td>{formatMoney(worker.cost.usd)}</td>
              <td>
                {worker.cost.tokensIn.toLocaleString()} / {worker.cost.tokensOut.toLocaleString()}
              </td>
              <td>{formatMinutes(worker.cost.minutes)}</td>
            </tr>
          ))}
          {workers.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                暂无花费记录
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab(): JSX.Element {
  const { project, assistant, busy, onProjectSettings, onAssistant } = useWorkbench();
  const [budget, setBudget] = useState(String(project.dailyBudgetUsd));
  const [concurrency, setConcurrency] = useState(String(project.maxConcurrency));
  const [name, setName] = useState(assistant.name);
  const [tone, setTone] = useState<Assistant['tone']>(assistant.tone);
  const [proactivity, setProactivity] = useState<Assistant['proactivity']>(assistant.proactivity);
  const [notice, setNotice] = useState<string | null>(null);
  const [llm, setLlm] = useState<SecretsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .secrets()
      .then((status) => {
        if (alive) setLlm(status);
      })
      .catch((caught: unknown) => {
        if (alive) setNotice(errorText(caught));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setBudget(String(project.dailyBudgetUsd));
    setConcurrency(String(project.maxConcurrency));
  }, [project.id, project.dailyBudgetUsd, project.maxConcurrency]);

  useEffect(() => {
    setName(assistant.name);
    setTone(assistant.tone);
    setProactivity(assistant.proactivity);
  }, [assistant.name, assistant.tone, assistant.proactivity]);

  const saveProject = async (): Promise<void> => {
    const usd = Number(budget);
    const max = Number(concurrency);
    if (!Number.isFinite(usd) || usd <= 0) {
      setNotice('日预算必须是正数');
      return;
    }
    if (!Number.isInteger(max) || max < 1 || max > 8) {
      setNotice('并发上限需为 1-8 的整数');
      return;
    }
    setNotice(null);
    try {
      await onProjectSettings({ dailyBudgetUsd: usd, maxConcurrency: max });
      setNotice('项目设置已保存');
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  const saveAssistant = async (): Promise<void> => {
    setNotice(null);
    try {
      await onAssistant({ name: name.trim() || assistant.name, tone, proactivity });
      setNotice('总管设置已保存');
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  const saveKey = async (): Promise<void> => {
    const value = apiKey.trim();
    if (value === '') {
      setNotice('先填入密钥');
      return;
    }
    setKeyBusy(true);
    setNotice(null);
    try {
      setLlm(await api.setLlmKey(value));
      setApiKey('');
      setNotice('密钥已保存；点顶栏刷新后规划切换为 LLM。');
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setKeyBusy(true);
    setNotice(null);
    try {
      setLlm(await api.clearLlmKey());
      setNotice('已清除密钥；规划回落到静态规则。');
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <div className="settings">
      <div className="settings-block">
        <h3>项目</h3>
        <p className="muted">{project.path}</p>
        <label>
          日预算（USD）
          <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          项目并发上限
          <input
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <button disabled={busy} onClick={() => void saveProject()}>
          保存项目设置
        </button>
      </div>
      <div className="settings-block">
        <h3>总管</h3>
        <label>
          名字
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          语气
          <select value={tone} onChange={(event) => setTone(event.target.value as Assistant['tone'])}>
            <option value="concise">简洁</option>
            <option value="detailed">详细</option>
          </select>
        </label>
        <label>
          主动性
          <select
            value={proactivity}
            onChange={(event) => setProactivity(event.target.value as Assistant['proactivity'])}
          >
            <option value="ask_first">先问再做</option>
            <option value="act_first">先做再报</option>
          </select>
        </label>
        <button disabled={busy} onClick={() => void saveAssistant()}>
          保存总管设置
        </button>
      </div>
      <div className="settings-block">
        <h3>模型密钥</h3>
        <p className="muted">
          当前：
          {llm === null
            ? '读取中…'
            : llm.llm.configured
              ? `已配置（${llm.llm.source === 'vault' ? '本机凭据库' : '环境变量'}）`
              : '未配置，规划走静态规则'}
        </p>
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            placeholder="sk-…"
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveKey();
            }}
          />
        </label>
        <div className="row">
          <button disabled={keyBusy || busy} onClick={() => void saveKey()}>
            保存密钥
          </button>
          <button
            className="ghost"
            disabled={keyBusy || busy || !llm?.llm.configured}
            onClick={() => void clearKey()}
          >
            清除
          </button>
        </div>
        <p className="hint">
          密钥只存本机凭据库（{llm?.backend === 'dpapi' ? 'Windows DPAPI' : '本机'}），不会写进项目文件；保存后点顶栏刷新即可生效。
        </p>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
    </div>
  );
}

const MEMORY_LABELS: Record<MemoryKind, string> = {
  profile: '偏好',
  project: '项目',
  decision: '决策',
  lesson: '教训',
};

function MemoryTab(): JSX.Element {
  const { project, snapshot } = useWorkbench();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [kind, setKind] = useState<MemoryKind>('profile');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MemoryMatch[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .memory(project.id)
      .then((data) => {
        if (!alive) return;
        setEntries(data.entries);
        setReport(data.report);
      })
      .catch((caught: unknown) => {
        if (alive) setNotice(errorText(caught));
      });
    return () => {
      alive = false;
    };
  }, [project.id, tick]);

  const add = async (): Promise<void> => {
    if (!text.trim()) return;
    try {
      const result = await api.rememberMemory({
        kind,
        text: text.trim(),
        source: 'user:manual',
        projectId: project.id,
      });
      setNotice(
        result.action === 'superseded'
          ? '已写入并取代同键旧记忆'
          : result.action === 'deduped'
            ? '已有相同记忆，未重复写入'
            : '已记住',
      );
      setText('');
      setTick((value) => value + 1);
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api.removeMemory(id);
      setTick((value) => value + 1);
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  /** 跨项目检索：只读，不改变各条记忆的使用统计。 */
  const searchAll = async (): Promise<void> => {
    const keyword = query.trim();
    if (keyword === '') return;
    setSearching(true);
    try {
      const result = await api.memorySearchAll(keyword);
      setMatches(result.matches);
      if (result.matches.length === 0) setNotice('所有项目里都没有匹配的记忆。');
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setSearching(false);
    }
  };

  const projectName = (projectId: string | null): string =>
    projectId === null
      ? '全局'
      : (snapshot.projects.find((item) => item.id === projectId)?.name ?? projectId);

  const stats = report?.stats ?? snapshot.memory;

  return (
    <div className="memory">
      <div className="memory-stats">
        <span>共 {stats.total} 条</span>
        {MEMORY_KINDS.map((item) => (
          <span key={item} className="muted">
            {MEMORY_LABELS[item]} {stats.byKind[item]}
          </span>
        ))}
        <span className={stats.issues > 0 ? 'warn' : 'muted'}>检查项 {stats.issues}</span>
      </div>
      <div className="settings-block">
        <h3>记一条</h3>
        <div className="row">
          <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((item) => (
              <option key={item} value={item}>
                {MEMORY_LABELS[item]}
              </option>
            ))}
          </select>
          <input
            value={text}
            placeholder="例如：偏好 pnpm 工作区；提交信息用中文"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <button className="ghost" onClick={() => void add()} disabled={!text.trim()}>
            记住
          </button>
        </div>
        <p className="muted">写入有门槛：拒绝临时指令、疑似密钥与过短内容。</p>
      </div>
      <div className="settings-block">
        <h3>跨项目搜索</h3>
        <div className="row">
          <input
            value={query}
            placeholder="例如：pnpm 工作区"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void searchAll();
            }}
          />
          <button
            className="ghost"
            onClick={() => void searchAll()}
            disabled={!query.trim() || searching}
          >
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
        {matches && matches.length > 0 ? (
          <ul className="memory-list">
            {matches.map((match) => (
              <li key={match.entry.id}>
                <span className="memory-kind">{projectName(match.entry.projectId)}</span>
                <span className="memory-text">{match.entry.text}</span>
                <span className="muted">{match.entry.source}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="muted">覆盖所有项目与全局记忆，只读，不改变使用统计。</p>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
      {report && report.issues.length > 0 ? (
        <ul className="memory-issues">
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className={issue.severity}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="memory-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="memory-kind">{MEMORY_LABELS[entry.kind]}</span>
            <span className="memory-text">{entry.text}</span>
            <span className="muted">{entry.source}</span>
            <button className="ghost" onClick={() => void remove(entry.id)}>
              删除
            </button>
          </li>
        ))}
        {entries.length === 0 ? <li className="muted">还没有记忆。</li> : null}
      </ul>
    </div>
  );
}

export const inspectorTabPlugins: UiPlugin[] = [
  { id: 'inspector.timeline', title: '时间线', slot: 'bottom', order: 10, render: TimelineTab },
  { id: 'inspector.artifacts', title: '产物', slot: 'bottom', order: 20, render: ArtifactsTab },
  { id: 'inspector.summary', title: '汇总', slot: 'bottom', order: 30, render: SummaryTab },
  { id: 'inspector.cost', title: '花费', slot: 'bottom', order: 40, render: CostTab },
  { id: 'inspector.memory', title: '记忆', slot: 'bottom', order: 45, render: MemoryTab },
  { id: 'inspector.settings', title: '设置', slot: 'bottom', order: 50, render: SettingsTab },
];
