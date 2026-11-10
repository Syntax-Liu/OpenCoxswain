import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ChannelTransport,
  ChannelsService,
  EventService,
  StewardService,
  StorageService,
} from '@opencoxswain/plugin-api';
import type {
  ChannelEventKind,
  ChannelInboundResult,
  ChannelInput,
  ChannelKind,
  ChannelTestResult,
  ChannelView,
  EventRecord,
  Task,
  TaskStatus,
} from '@opencoxswain/shared';
import { CHANNEL_EVENT_KINDS, newId, now } from '@opencoxswain/shared';
import { AppError } from './errors.js';

/** 同一告警在窗口内只推一次，避免「执行失败 + 状态变更」重复轰炸。 */
const DEDUP_WINDOW_MS = 60_000;
const DEDUP_SWEEP_MS = 10 * 60_000;
const MAX_LIST_LINES = 10;
const MIN_ID_PREFIX = 4;

const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  planning: '规划中',
  awaiting_approval: '待审批',
  queued: '排队中',
  running: '执行中',
  awaiting_review: '待验收',
  paused: '已暂停',
  blocked: '受阻',
  failed: '失败',
  done: '已完成',
  cancelled: '已取消',
};

interface StoredChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  webhookUrl: string;
  secret: string;
  botToken: string;
  chatId: string;
  inboundToken: string;
  notify: ChannelEventKind[];
  createdAt: number;
  updatedAt: number;
  lastSentAt: number | null;
  lastError: string | null;
}

export interface ChannelDeps {
  store: StorageService;
  bus: EventService;
  steward: StewardService;
  filePath: string;
  log?: (message: string, detail?: unknown) => void;
  dedupWindowMs?: number;
}

export type ChannelCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'status'; id: string }
  | { kind: 'approve'; id: string }
  | { kind: 'reject'; id: string; note: string }
  | { kind: 'unknown'; text: string };

/**
 * 入站指令只覆盖「看一眼」与「拍板」两类动作：
 * 不开放建单，避免手机误触直接产生派发与成本。
 */
export function parseChannelCommand(text: string): ChannelCommand {
  const cleaned = text
    .replace(/@[^\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || cleaned === '?' || cleaned === '？') return { kind: 'help' };
  const [head = '', ...rest] = cleaned.split(' ');
  switch (head.toLowerCase()) {
    case '待办':
    case '任务':
    case '列表':
    case 'list':
      return { kind: 'list' };
    case '帮助':
    case 'help':
      return { kind: 'help' };
    case '状态':
    case 'status':
      return rest[0] ? { kind: 'status', id: rest[0] } : { kind: 'list' };
    case '批准':
    case '同意':
    case 'approve':
      return rest[0] ? { kind: 'approve', id: rest[0] } : { kind: 'unknown', text: cleaned };
    case '退回':
    case '驳回':
    case '打回':
    case 'reject': {
      if (!rest[0] || rest.length < 2) return { kind: 'unknown', text: cleaned };
      return { kind: 'reject', id: rest[0], note: rest.slice(1).join(' ') };
    }
    default:
      return { kind: 'unknown', text: cleaned };
  }
}

export class Channels implements ChannelsService {
  private stored: StoredChannel[] = [];
  private readonly transports = new Map<ChannelKind, ChannelTransport>();
  private readonly dedup = new Map<string, number>();
  private readonly window: number;

  constructor(private readonly deps: ChannelDeps) {
    this.window = deps.dedupWindowMs ?? DEDUP_WINDOW_MS;
    this.stored = this.load();
  }

  list(): ChannelView[] {
    return this.stored.map((channel) => this.view(channel));
  }

  get(id: string): ChannelView | null {
    const channel = this.stored.find((item) => item.id === id);
    return channel ? this.view(channel) : null;
  }

  save(input: ChannelInput): ChannelView {
    const at = now();
    if (input.id) {
      const channel = this.require(input.id);
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name === '') throw new AppError('通道名称不能为空');
        channel.name = name;
      }
      if (input.enabled !== undefined) channel.enabled = input.enabled;
      if (input.webhookUrl !== undefined) {
        channel.webhookUrl = this.cleanUrl(input.webhookUrl);
      }
      if (input.secret !== undefined) channel.secret = input.secret.trim();
      if (input.botToken !== undefined) channel.botToken = input.botToken.trim();
      if (input.chatId !== undefined) channel.chatId = input.chatId.trim();
      if (input.notify !== undefined) channel.notify = this.cleanNotify(input.notify);
      channel.updatedAt = at;
      this.persist();
      return this.view(channel);
    }

    const kind: ChannelKind = input.kind === 'telegram' ? 'telegram' : 'feishu';
    const channel: StoredChannel = {
      id: newId('chn'),
      kind,
      name: input.name?.trim() || (kind === 'telegram' ? 'Telegram' : '飞书'),
      enabled: input.enabled ?? true,
      webhookUrl: this.cleanUrl(input.webhookUrl ?? ''),
      secret: input.secret?.trim() ?? '',
      botToken: input.botToken?.trim() ?? '',
      chatId: input.chatId?.trim() ?? '',
      // 入站 token 一旦生成就固定，复制到飞书后台后不需要再改。
      // Telegram 侧直接把它用作 setWebhook 的 secret_token。
      inboundToken: newId('itk'),
      notify: this.cleanNotify(input.notify),
      createdAt: at,
      updatedAt: at,
      lastSentAt: null,
      lastError: null,
    };
    this.stored.push(channel);
    this.persist();
    return this.view(channel);
  }

  remove(id: string): boolean {
    const index = this.stored.findIndex((channel) => channel.id === id);
    if (index < 0) return false;
    this.stored.splice(index, 1);
    for (const key of [...this.dedup.keys()]) {
      if (key.startsWith(`${id}|`)) this.dedup.delete(key);
    }
    this.persist();
    return true;
  }

  async test(id: string): Promise<ChannelTestResult> {
    const channel = this.require(id);
    const missing = this.missingConfig(channel);
    if (missing !== null) throw new AppError(missing);
    try {
      await this.deliver(channel, '【OpenCoxswain】通道测试：收到这条消息说明配置可用。');
      this.markSent(channel);
      return { ok: true, error: null };
    } catch (error) {
      this.markError(channel, error);
      return { ok: false, error: errorText(error) };
    }
  }

  registerTransport(kind: ChannelKind, transport: ChannelTransport): () => void {
    this.transports.set(kind, transport);
    return () => {
      if (this.transports.get(kind) === transport) this.transports.delete(kind);
    };
  }

  async inbound(channelId: string, text: string): Promise<ChannelInboundResult> {
    const channel = this.require(channelId);
    if (!channel.enabled) return { handled: false, reply: '通道已停用，先在桌面端重新启用。' };
    const command = parseChannelCommand(text);
    try {
      switch (command.kind) {
        case 'help':
          return { handled: false, reply: HELP_TEXT };
        case 'list':
          return { handled: false, reply: this.listPending() };
        case 'status':
          return { handled: false, reply: this.describe(command.id) };
        case 'approve':
          return { handled: true, reply: this.approve(command.id) };
        case 'reject':
          return { handled: true, reply: this.reject(command.id, command.note) };
        default:
          return {
            handled: false,
            reply: `没看懂「${command.text}」。\n\n${HELP_TEXT}`,
          };
      }
    } catch (error) {
      return { handled: true, reply: `操作失败：${errorText(error)}` };
    }
  }

  async sendText(channelId: string, text: string): Promise<boolean> {
    const channel = this.stored.find((item) => item.id === channelId);
    if (!channel || this.missingConfig(channel) !== null) return false;
    try {
      await this.deliver(channel, text);
      this.markSent(channel);
      return true;
    } catch (error) {
      this.markError(channel, error);
      return false;
    }
  }

  dispatch(event: EventRecord): void {
    const message = this.mapEvent(event);
    if (!message) return;
    this.notice(message);
  }

  notice(input: { kind: ChannelEventKind; dedupKey: string; text: string }): void {
    const targets = this.stored.filter(
      (channel) =>
        channel.enabled &&
        this.missingConfig(channel) === null &&
        channel.notify.includes(input.kind),
    );
    if (targets.length === 0) return;
    const at = now();
    for (const channel of targets) {
      const key = `${channel.id}|${input.dedupKey}`;
      const seen = this.dedup.get(key);
      if (seen !== undefined && at - seen < this.window) continue;
      this.dedup.set(key, at);
      void this.deliver(channel, input.text)
        .then(() => this.markSent(channel))
        .catch((error: unknown) => this.markError(channel, error));
    }
    this.sweep(at);
  }

  start(): () => void {
    const unsubscribe = this.deps.bus.subscribe((event) => this.dispatch(event));
    return () => {
      unsubscribe();
      this.dedup.clear();
    };
  }

  private mapEvent(event: EventRecord): {
    kind: ChannelEventKind;
    dedupKey: string;
    text: string;
  } | null {
    const task = event.taskId ? this.deps.store.getTask(event.taskId) : null;
    const title = task ? task.title : event.taskId ? event.taskId.slice(0, 12) : '（无任务）';
    const payload = asRecord(event.payload);

    if (event.type === 'approval.requested') {
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
      if (approvalId === '') return null;
      const tool = typeof payload.tool === 'string' ? payload.tool : '工具调用';
      const category = typeof payload.category === 'string' ? payload.category : '';
      return {
        kind: 'approval',
        dedupKey: `approval:${approvalId}`,
        text: [
          '【待审批】',
          `任务：${title}`,
          `动作：${tool}${category ? `（${category}）` : ''}`,
          `回复「批准 ${short(approvalId)}」放行，或「退回 ${short(approvalId)} 理由」拒绝。`,
        ].join('\n'),
      };
    }

    if (event.type === 'task.status_changed') {
      const to = typeof payload.to === 'string' ? payload.to : '';
      if (to === 'awaiting_review') {
        return {
          kind: 'review',
          dedupKey: `review:${event.taskId ?? ''}`,
          text: [
            '【待验收】',
            `任务：${title}`,
            '请在桌面端查看交付说明与 diff，验收结论只能由你给出。',
          ].join('\n'),
        };
      }
      if (to === 'failed') {
        return {
          kind: 'failure',
          dedupKey: `failure:${event.taskId ?? ''}`,
          text: ['【执行失败】', `任务：${title}`, '可在桌面端查看日志并重试。'].join('\n'),
        };
      }
      if (to === 'blocked') {
        return {
          kind: 'budget',
          dedupKey: `blocked:${event.taskId ?? ''}`,
          text: ['【任务受阻】', `任务：${title}`, '预算或权限触发拦截，请看桌面端提示。'].join(
            '\n',
          ),
        };
      }
      return null;
    }

    if (event.type === 'budget.exceeded') {
      const scope = typeof payload.scope === 'string' ? payload.scope : 'task';
      const used = typeof payload.used === 'number' ? payload.used.toFixed(2) : '?';
      const limit =
        typeof payload.budget === 'number'
          ? payload.budget.toFixed(2)
          : typeof payload.limit === 'number'
            ? payload.limit.toFixed(2)
            : '?';
      const label = scope === 'daily' ? '项目日预算' : '任务预算';
      return {
        kind: 'budget',
        dedupKey: `budget:${scope}:${event.taskId ?? payload.projectId ?? ''}`,
        text: [`【预算超限】${label}：已用 $${used} / 上限 $${limit}`, `任务：${title}`].join(
          '\n',
        ),
      };
    }

    if (event.type === 'worker.failed') {
      const message = typeof payload.message === 'string' ? payload.message : '未知错误';
      return {
        kind: 'failure',
        dedupKey: `failure:${event.taskId ?? ''}`,
        text: ['【执行失败】', `任务：${title}`, `原因：${message}`].join('\n'),
      };
    }

    return null;
  }

  private approve(id: string): string {
    const target = this.resolve(id);
    if (target.type === 'approval') {
      this.deps.steward.decideApproval(target.approvalId, 'approved');
      return `已批准审批 ${short(target.approvalId)}，任务会继续执行。`;
    }
    const task = this.deps.steward.approveTask(target.task.id);
    return `已批准任务「${task.title}」，开始派发。`;
  }

  private reject(id: string, note: string): string {
    const target = this.resolve(id);
    if (target.type === 'approval') {
      this.deps.steward.decideApproval(target.approvalId, 'rejected');
      return `已拒绝审批 ${short(target.approvalId)}。理由将用于后续判断：${note}`;
    }
    const task = this.deps.steward.rejectTask(target.task.id, note);
    return `已退回任务「${task.title}」：${note}`;
  }

  private resolve(
    id: string,
  ): { type: 'task'; task: Task } | { type: 'approval'; approvalId: string } {
    const prefix = id.trim();
    if (prefix.length < MIN_ID_PREFIX) {
      throw new AppError(`id 至少 ${MIN_ID_PREFIX} 位，避免误命中`);
    }
    const tasks = this.allTasks().filter((task) => task.id.startsWith(prefix));
    const approvals = this.allPendingApprovals().filter((item) => item.id.startsWith(prefix));
    const total = tasks.length + approvals.length;
    if (total === 0) throw new AppError('没有找到匹配的任务或审批');
    if (total > 1) {
      const candidates = [
        ...tasks.map((task) => `${short(task.id)}（任务）`),
        ...approvals.map((item) => `${short(item.id)}（审批）`),
      ];
      throw new AppError(`匹配到多条，请输入更长的 id：${candidates.join('、')}`);
    }
    if (tasks.length === 1) {
      const task = tasks[0];
      if (!task) throw new AppError('没有找到匹配的任务或审批');
      return { type: 'task', task };
    }
    const approval = approvals[0];
    if (!approval) throw new AppError('没有找到匹配的任务或审批');
    return { type: 'approval', approvalId: approval.id };
  }

  private listPending(): string {
    const lines: string[] = [];
    let hidden = 0;
    for (const project of this.deps.store.listProjects()) {
      for (const task of this.deps.store.listTasks(project.id)) {
        if (!PENDING_STATUSES.has(task.status)) continue;
        if (lines.length >= MAX_LIST_LINES) {
          hidden += 1;
          continue;
        }
        lines.push(
          `· ${short(task.id)} ${STATUS_LABELS[task.status]}｜${project.name}｜${task.title}`,
        );
      }
      for (const approval of this.deps.store.listApprovals(project.id)) {
        if (approval.status !== 'pending') continue;
        if (lines.length >= MAX_LIST_LINES) {
          hidden += 1;
          continue;
        }
        lines.push(`· ${short(approval.id)} 工具审批｜${project.name}｜${approval.type}`);
      }
    }
    if (lines.length === 0) return '当前没有待审批或待验收的任务。';
    if (hidden > 0) lines.push(`……还有 ${hidden} 条，请在桌面端查看。`);
    return ['当前待处理：', ...lines].join('\n');
  }

  private describe(id: string): string {
    const prefix = id.trim();
    if (prefix.length < MIN_ID_PREFIX) {
      throw new AppError(`id 至少 ${MIN_ID_PREFIX} 位，避免误命中`);
    }
    const task = this.allTasks().find((item) => item.id.startsWith(prefix));
    if (task) {
      const project = this.deps.store.getProject(task.projectId);
      return [
        `任务：${task.title}`,
        `状态：${STATUS_LABELS[task.status]}`,
        `项目：${project?.name ?? task.projectId}`,
      ].join('\n');
    }
    const approval = this.allPendingApprovals().find((item) => item.id.startsWith(prefix));
    if (approval) {
      return [
        `工具审批：${approval.type}`,
        '状态：待审批',
        `回复「批准 ${short(approval.id)}」或「退回 ${short(approval.id)} 理由」。`,
      ].join('\n');
    }
    throw new AppError('没有找到匹配的任务或审批');
  }

  private allTasks(): Task[] {
    return this.deps.store
      .listProjects()
      .flatMap((project) => this.deps.store.listTasks(project.id));
  }

  private allPendingApprovals(): Array<{ id: string; type: string }> {
    return this.deps.store.listProjects().flatMap((project) =>
      this.deps.store
        .listApprovals(project.id)
        .filter((approval) => approval.status === 'pending')
        .map((approval) => ({ id: approval.id, type: approval.type })),
    );
  }

  private async deliver(channel: StoredChannel, text: string): Promise<void> {
    const transport = this.transports.get(channel.kind);
    if (!transport) {
      throw new AppError(`通道 ${channel.kind} 的发送实现尚未加载`, 503);
    }
    await transport.send({
      webhookUrl: channel.webhookUrl,
      secret: channel.secret,
      botToken: channel.botToken,
      chatId: channel.chatId,
      text,
    });
  }

  /** 返回还缺哪项配置；null 表示可以直接发送。 */
  private missingConfig(channel: StoredChannel): string | null {
    if (channel.kind === 'telegram') {
      if (channel.botToken === '') return '先填 Bot Token';
      if (channel.chatId === '') return '先填会话 ID（chat_id）';
      return null;
    }
    return channel.webhookUrl === '' ? '先填 Webhook 地址' : null;
  }

  private markSent(channel: StoredChannel): void {
    channel.lastSentAt = now();
    channel.lastError = null;
    this.persist();
  }

  private markError(channel: StoredChannel, error: unknown): void {
    channel.lastError = errorText(error);
    this.persist();
    this.deps.log?.('通道发送失败', { channel: channel.id, error: channel.lastError });
  }

  private view(channel: StoredChannel): ChannelView {
    return {
      id: channel.id,
      kind: channel.kind,
      name: channel.name,
      enabled: channel.enabled,
      webhookConfigured: channel.webhookUrl !== '',
      secretConfigured: channel.secret !== '',
      botTokenConfigured: channel.botToken !== '',
      chatId: channel.chatId,
      notify: [...channel.notify],
      inboundPath:
        channel.kind === 'telegram'
          ? `/api/channels/${channel.id}/inbound/telegram`
          : `/api/channels/${channel.id}/inbound`,
      inboundToken: channel.inboundToken,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      lastSentAt: channel.lastSentAt,
      lastError: channel.lastError,
    };
  }

  private require(id: string): StoredChannel {
    const channel = this.stored.find((item) => item.id === id);
    if (!channel) throw new AppError('通道不存在', 404);
    return channel;
  }

  private cleanUrl(value: string): string {
    const url = value.trim();
    if (url === '') return '';
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new AppError('Webhook 必须是 http(s) 地址');
    }
    return url;
  }

  private cleanNotify(value: ChannelEventKind[] | undefined): ChannelEventKind[] {
    if (value === undefined) return [...CHANNEL_EVENT_KINDS];
    const unique = new Set<ChannelEventKind>();
    for (const kind of value) {
      if (CHANNEL_EVENT_KINDS.includes(kind)) unique.add(kind);
    }
    return [...unique];
  }

  private sweep(at: number): void {
    for (const [key, timestamp] of this.dedup) {
      if (at - timestamp >= DEDUP_SWEEP_MS) this.dedup.delete(key);
    }
  }

  private load(): StoredChannel[] {
    let raw: string;
    try {
      raw = readFileSync(this.deps.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => this.normalize(item))
        .filter((item): item is StoredChannel => item !== null);
    } catch {
      this.deps.log?.('通道配置不是合法 JSON，已按空配置启动', this.deps.filePath);
      return [];
    }
  }

  private normalize(value: unknown): StoredChannel | null {
    const raw = asRecord(value);
    if (typeof raw.id !== 'string' || typeof raw.webhookUrl !== 'string') return null;
    const kind: ChannelKind = raw.kind === 'telegram' ? 'telegram' : 'feishu';
    const notify = Array.isArray(raw.notify)
      ? this.cleanNotify(raw.notify.filter((item): item is ChannelEventKind => typeof item === 'string'))
      : [...CHANNEL_EVENT_KINDS];
    return {
      id: raw.id,
      kind,
      name: typeof raw.name === 'string' ? raw.name : kind === 'telegram' ? 'Telegram' : '飞书',
      enabled: raw.enabled !== false,
      webhookUrl: raw.webhookUrl,
      secret: typeof raw.secret === 'string' ? raw.secret : '',
      botToken: typeof raw.botToken === 'string' ? raw.botToken : '',
      chatId: typeof raw.chatId === 'string' ? raw.chatId : '',
      inboundToken: typeof raw.inboundToken === 'string' ? raw.inboundToken : newId('itk'),
      notify,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now(),
      lastSentAt: typeof raw.lastSentAt === 'number' ? raw.lastSentAt : null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.deps.filePath), { recursive: true });
    writeFileSync(this.deps.filePath, JSON.stringify(this.stored, null, 2), 'utf8');
  }
}

const PENDING_STATUSES = new Set<TaskStatus>(['awaiting_approval', 'awaiting_review', 'blocked']);

const HELP_TEXT = [
  '我能帮你：',
  '· 待办 —— 列出待审批 / 待验收的任务',
  '· 状态 <id> —— 查看任务或审批进度',
  '· 批准 <id> —— 批准开工或工具审批',
  '· 退回 <id> <理由> —— 驳回，理由必填',
  '派单与验收结论请在桌面端完成。',
].join('\n');

function short(id: string): string {
  return id.slice(0, 12);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
