import { useEffect, useState } from 'react';
import type {
  ArtifactRecord,
  Assistant,
  ChannelEventKind,
  ChannelInput,
  ChannelView,
  EventRecord,
  GateQuality,
  MemoryEntry,
  MemoryKind,
  MemoryMatch,
  MemoryReport,
} from '@opencoxswain/shared';
import { CHANNEL_EVENT_KINDS, MEMORY_KINDS } from '@opencoxswain/shared';
import { api, DAEMON_URL, desktop, errorText } from '../api.js';
import type {
  RemoteJobStatus,
  RemoteNodeStatus,
  RemoteNodeView,
  RemoteStatus,
  SecretsStatus,
  UpdateStatus,
} from '../api.js';
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
                  ? `，${selected.meta.files ?? 0} 文件 +${selected.meta.additions ?? 0} -${selected.meta.deletions ?? 0}`
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

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function CostTab(): JSX.Element {
  const { workers, tasks, project } = useWorkbench();
  const [gates, setGates] = useState<GateQuality | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .gateQuality(project.id)
      .then((quality) => {
        if (alive) {
          setGates(quality);
          setGateError(null);
        }
      })
      .catch((caught: unknown) => {
        if (alive) setGateError(errorText(caught));
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

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
      <div className="settings-block">
        <h3>验收门禁</h3>
        {gateError ? <p className="error">{gateError}</p> : null}
        {!gates && !gateError ? <p className="hint">读取门禁统计…</p> : null}
        {gates ? (
          <>
            <div className="cost-summary">
              <div>
                <span>系统自动判定</span>
                <strong>
                  {gates.systemPassed} / {gates.systemJudged}
                </strong>
              </div>
              <div>
                <span>系统拦下</span>
                <strong>{gates.systemFailed}</strong>
              </div>
              <div>
                <span>待人工判定</span>
                <strong>{gates.unverified}</strong>
              </div>
              <div>
                <span>人工收口</span>
                <strong>
                  {gates.humanPassed} / {gates.humanJudged}
                </strong>
              </div>
            </div>
            <p className="hint">
              自动通过率 {percent(gates.autoPassRate)}，人工通过率 {percent(gates.humanPassRate)}
              。系统判失败会直接让任务失败，不接受人工覆盖；只有未能判定的项才交给人。
            </p>
          </>
        ) : null}
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

const CHANNEL_KIND_LABELS: Record<ChannelEventKind, string> = {
  approval: '待审批',
  review: '待验收',
  budget: '预算/受阻',
  failure: '执行失败',
  orphan: '遗留进程',
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 回退到 execCommand，桌面端不保证有剪贴板权限
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function ChannelSettings(): JSX.Element {
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .channels()
      .then((data) => {
        if (alive) setChannels(data.channels);
      })
      .catch((caught: unknown) => {
        if (alive) setNotice(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const add = async (kind: 'feishu' | 'telegram'): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const label = kind === 'telegram' ? 'Telegram' : '飞书';
      const channel = await api.createChannel({
        kind,
        name: `${label} ${channels.length + 1}`,
      });
      setChannels((prev) => [...prev, channel]);
      setNotice(
        kind === 'telegram'
          ? '已创建；填好 Bot Token 与会话 ID 后点「发测试消息」验证。'
          : '已创建；填好 Webhook 后点「发测试消息」验证。',
      );
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-block settings-wide">
      <h3>通知通道</h3>
      <p className="hint">
        任务有进展时推到飞书群或 Telegram；在群里回「待办」「批准 id」「退回 id 理由」即可处理。验收结论与派单仍在桌面端完成。
      </p>
      <p className="hint">
        Telegram 的入站指令要求公开 HTTPS 地址，本机测试可先用 `setWebhook` 把入站地址通过隧道暴露出去；只填 Bot Token
        与会话 ID 也能收到全部推送。
      </p>
      {loading ? <p className="muted">读取中…</p> : null}
      {!loading && channels.length === 0 ? (
        <p className="muted">还没有通道，先建一个飞书群机器人或 Telegram 机器人。</p>
      ) : null}
      {channels.map((channel) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          onChanged={(updated) =>
            setChannels((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
          }
          onRemoved={(id) => setChannels((prev) => prev.filter((item) => item.id !== id))}
        />
      ))}
      <div className="row">
        <button disabled={busy} onClick={() => void add('feishu')}>
          新增飞书通道
        </button>
        <button disabled={busy} onClick={() => void add('telegram')}>
          新增 Telegram 通道
        </button>
      </div>
      {notice ? <p className="hint">{notice}</p> : null}
    </div>
  );
}

function ChannelCard({
  channel,
  onChanged,
  onRemoved,
}: {
  channel: ChannelView;
  onChanged: (channel: ChannelView) => void;
  onRemoved: (id: string) => void;
}): JSX.Element {
  const isTelegram = channel.kind === 'telegram';
  const [webhook, setWebhook] = useState('');
  const [secret, setSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(channel.chatId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const patch = async (input: ChannelInput, message: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.updateChannel(channel.id, input);
      onChanged(updated);
      setNotice(message);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveCredentials = async (): Promise<void> => {
    const input: ChannelInput = {};
    if (isTelegram) {
      if (botToken.trim() !== '') input.botToken = botToken.trim();
      input.chatId = chatId.trim();
    } else {
      input.webhookUrl = webhook.trim();
      if (secret.trim() !== '') input.secret = secret.trim();
    }
    await patch(input, '凭据已保存');
    setWebhook('');
    setSecret('');
    setBotToken('');
  };

  const test = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.testChannel(channel.id);
      setNotice(result.ok ? '测试消息已发出，去群里看看' : `发送失败：${result.error ?? '未知错误'}`);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleNotify = async (kind: ChannelEventKind): Promise<void> => {
    const notify = channel.notify.includes(kind)
      ? channel.notify.filter((item) => item !== kind)
      : [...channel.notify, kind];
    await patch({ notify }, '通知范围已保存');
  };

  const copy = async (text: string, label: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    setNotice(ok ? `${label}已复制` : '复制失败，请手动选中复制');
  };

  const inboundUrl = `${DAEMON_URL}${channel.inboundPath}`;
  const configuredText = isTelegram
    ? `${channel.botTokenConfigured ? 'Bot Token 已配置' : 'Bot Token 未配置'}，${
        channel.chatId !== '' ? '会话已绑定' : '会话未填'
      }`
    : channel.webhookConfigured
      ? 'Webhook 已配置'
      : 'Webhook 未配置';

  return (
    <div className="channel-card">
      <div className="channel-head">
        <strong>{channel.name}</strong>
        <span className="channel-state">
          {channel.enabled ? '已启用' : '已停用'}，{configuredText}
        </span>
      </div>
      {isTelegram ? (
        <>
          <label>
            Bot Token
            <input
              type="password"
              value={botToken}
              placeholder={
                channel.botTokenConfigured
                  ? '已配置；留空保存表示不修改'
                  : '从 @BotFather 获取的 123456:ABC-DEF…'
              }
              onChange={(event) => setBotToken(event.target.value)}
            />
          </label>
          <label>
            会话 ID（chat_id）
            <input
              value={chatId}
              placeholder="先给机器人发条消息，再用 getUpdates 查看 chat.id"
              onChange={(event) => setChatId(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Webhook 地址
            <input
              value={webhook}
              placeholder={
                channel.webhookConfigured
                  ? '已配置；留空保存会清除'
                  : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
              }
              onChange={(event) => setWebhook(event.target.value)}
            />
          </label>
          <label>
            签名密钥（可选）
            <input
              type="password"
              value={secret}
              placeholder={channel.secretConfigured ? '已配置；填写新值覆盖' : '飞书机器人签名校验'}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        </>
      )}
      <div className="row">
        <button disabled={busy} onClick={() => void saveCredentials()}>
          保存凭据
        </button>
        <button disabled={busy} onClick={() => void test()}>
          发测试消息
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => void patch({ enabled: !channel.enabled }, channel.enabled ? '已停用' : '已启用')}
        >
          {channel.enabled ? '停用' : '启用'}
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`删除通道「${channel.name}」？`)) return;
            setBusy(true);
            try {
              await api.removeChannel(channel.id);
              onRemoved(channel.id);
            } catch (caught) {
              setNotice(errorText(caught));
              setBusy(false);
            }
          }}
        >
          删除
        </button>
      </div>
      <div>
        <p className="muted">通知范围</p>
        <div className="row">
          {CHANNEL_EVENT_KINDS.map((kind) => (
            <label className="channel-check" key={kind}>
              <input
                type="checkbox"
                checked={channel.notify.includes(kind)}
                disabled={busy}
                onChange={() => void toggleNotify(kind)}
              />
              {CHANNEL_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="muted">
          {isTelegram ? '入站地址（setWebhook 的 url）' : '入站指令地址（填到飞书事件订阅）'}
        </p>
        <div className="row">
          <input readOnly value={inboundUrl} onFocus={(event) => event.currentTarget.select()} />
          <button className="ghost" onClick={() => void copy(inboundUrl, '地址')}>
            复制
          </button>
        </div>
      </div>
      <div>
        <p className="muted">
          {isTelegram
            ? 'secret_token（setWebhook 时填这个值）'
            : '入站 token（签名密钥，或拼在地址后的 ?token=）'}
        </p>
        <div className="row">
          <input
            readOnly
            value={channel.inboundToken}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="ghost" onClick={() => void copy(channel.inboundToken, 'token')}>
            复制
          </button>
        </div>
      </div>
      {channel.lastSentAt ? (
        <p className="hint">最近发送：{formatDateTime(channel.lastSentAt)}</p>
      ) : null}
      {channel.lastError ? <p className="hint">最近错误：{channel.lastError}</p> : null}
      {notice ? <p className="hint">{notice}</p> : null}
    </div>
  );
}

function VersionSettings(): JSX.Element {
  const [current, setCurrent] = useState('—');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop.available) return;
    let alive = true;
    desktop
      .version()
      .then((version) => {
        if (alive) setCurrent(version);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const check = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await desktop.updateCheck();
      setStatus(result);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    setBusy(true);
    setNotice('正在下载并安装，完成后应用会自动重启…');
    try {
      const version = await desktop.updateInstall();
      setNotice(`已安装 ${version}，正在重启`);
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-block settings-wide">
      <h3>版本与更新</h3>
      <p className="muted">
        当前版本 {current}
        {desktop.available ? '' : '（浏览器调试环境不支持自动更新）'}
      </p>
      {desktop.available ? (
        <div className="row">
          <button disabled={busy} onClick={() => void check()}>
            检查更新
          </button>
          {status?.latestVersion ? (
            <button disabled={busy} onClick={() => void install()}>
              更新到 {status.latestVersion}
            </button>
          ) : null}
        </div>
      ) : null}
      {status && !status.configured ? (
        <p className="hint">
          还没有配置更新源。在 <code>%LOCALAPPDATA%\OpenCoxswain\updater.json</code> 写入{' '}
          <code>{'{"endpoint":"https://…/latest.json","pubkey":"…"}'}</code> 后重启应用；升级包与
          <code>.sig</code> 由发布机用私钥签名。
        </p>
      ) : null}
      {status?.error ? <p className="error">{status.error}</p> : null}
      {status?.latestVersion ? (
        <>
          <p className="hint">
            发现新版本 {status.latestVersion}
            {status.date ? `（${status.date.slice(0, 10)} 发布）` : ''}
          </p>
          {status.notes ? <pre className="update-notes">{status.notes}</pre> : null}
        </>
      ) : null}
      {status && status.configured && !status.error && !status.latestVersion ? (
        <p className="hint">已是最新版本。</p>
      ) : null}
      {notice ? <p className="hint">{notice}</p> : null}
    </div>
  );
}

const REMOTE_NODE_LABELS: Record<RemoteNodeStatus, string> = {
  idle: '空闲',
  busy: '忙碌',
  offline: '离线',
};

const REMOTE_JOB_LABELS: Record<RemoteJobStatus, string> = {
  queued: '排队中',
  assigned: '执行中',
  succeeded: '已完成',
  failed: '失败',
  expired: '已过期',
  cancelled: '已取消',
};

function RemoteSettings(): JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .remote()
      .then((data) => {
        if (alive) setStatus(data);
      })
      .catch((caught: unknown) => {
        if (alive) setNotice(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      setStatus(await api.remote());
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (): Promise<void> => {
    if (!status) return;
    setBusy(true);
    setNotice(null);
    try {
      setStatus(status.enabled ? await api.remoteDisable() : await api.remoteEnable());
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    setNotice(ok ? '接入令牌已复制' : '复制失败，请手动选中复制');
  };

  const remove = async (node: RemoteNodeView): Promise<void> => {
    if (!window.confirm(`移除节点「${node.name}」？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.remoteRemoveNode(node.id);
      setStatus(await api.remote());
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled === true;
  const token = status?.enrollmentToken ?? '';
  const nodes = status?.nodes ?? [];
  const openJobs = (status?.jobs ?? []).filter(
    (job) => job.status === 'queued' || job.status === 'assigned',
  );
  const nodeName = (id: string | null): string =>
    nodes.find((node) => node.id === id)?.name ?? '待分配';

  return (
    <div className="settings-block settings-wide">
      <h3>远程节点</h3>
      <p className="muted">
        当前：
        {status === null ? '读取中…' : enabled ? '已开启' : '未开启'}
        {enabled ? `；节点每 ${Math.round((status?.heartbeatMs ?? 0) / 1000)} 秒心跳一次` : ''}
      </p>
      <p className="hint">
        开启后节点用接入令牌主动连入；代码仍会回传本地复核，节点自报的结论不采信。
      </p>
      {enabled ? (
        <div>
          <p className="muted">接入令牌（节点注册时填写）</p>
          <div className="row">
            <input readOnly value={token} onFocus={(event) => event.currentTarget.select()} />
            <button className="ghost" onClick={() => void copy(token)}>
              复制
            </button>
          </div>
        </div>
      ) : null}
      <div className="row">
        <button disabled={busy || status === null} onClick={() => void toggle()}>
          {enabled ? '关闭远程执行' : '开启远程执行'}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void load()}>
          刷新
        </button>
      </div>
      <div>
        <p className="muted">节点</p>
        {loading ? <p className="muted">读取中…</p> : null}
        {!loading && nodes.length === 0 ? (
          <p className="hint">还没有节点接入，开启远程执行后把令牌填到节点侧。</p>
        ) : null}
        {nodes.map((node) => (
          <div className="row wrap" key={node.id}>
            <strong>{node.name}</strong>
            <span className="muted">{REMOTE_NODE_LABELS[node.status]}</span>
            <span className="hint">最近心跳：{formatDateTime(node.lastSeenAt)}</span>
            <button className="ghost" disabled={busy} onClick={() => void remove(node)}>
              移除
            </button>
          </div>
        ))}
      </div>
      <div>
        <p className="muted">进行中的远程任务</p>
        {openJobs.length === 0 ? (
          <p className="hint">当前没有进行中的远程任务。</p>
        ) : (
          openJobs.map((job) => (
            <div className="row wrap" key={job.id}>
              <span>{job.id}</span>
              <span className="muted">{job.branch}</span>
              <span className="muted">{REMOTE_JOB_LABELS[job.status]}</span>
              <span className="hint">节点：{nodeName(job.nodeId)}</span>
            </div>
          ))
        )}
      </div>
      {notice ? <p className="hint">{notice}</p> : null}
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
      <ChannelSettings />
      <VersionSettings />
      <RemoteSettings />
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
  { id: 'context.timeline', title: '时间线', slot: 'context', order: 20, render: TimelineTab },
  { id: 'page.artifacts', title: '产物', slot: 'page', order: 40, render: ArtifactsTab },
  { id: 'context.summary', title: '汇总', slot: 'context', order: 30, render: SummaryTab },
  { id: 'page.cost', title: '花费', slot: 'page', order: 70, render: CostTab },
  { id: 'page.memory', title: '记忆', slot: 'page', order: 60, render: MemoryTab },
  { id: 'page.settings', title: '设置', slot: 'page', order: 80, render: SettingsTab },
];
