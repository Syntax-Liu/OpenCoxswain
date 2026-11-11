/**
 * IM 桥接：把手机上的消息接进 C 的会话。
 *
 * 核心约束（决定了整个设计）：**IM 不是第二个入口，是同一入口的另一个通道**。
 *
 * 所以这里：
 * - 收到的消息走**同一个** `orchestrator.userSays(projectId, text)`，
 *   和 Web 端一模一样。不新建会话、不分叉、不另起一套处理。
 * - 回复来自**同一个会话历史**，不是"IM 专用摘要"。
 * - 危险动作审批复用同一套审批记录，手机上点"批准"和网页上点效果相同。
 *
 * 这样才能保证"手机上聊的和电脑上聊的是同一件事"。
 */
import type { Orchestrator } from '../orchestrator.js';
import { isInternalSource, type Store } from '../store/store.js';
import { approveAction, rejectAction } from '../security/approval.js';
import type { TelegramClient, TelegramConfig } from './telegram.js';

export interface ImBridgeOptions {
  readonly client: TelegramClient;
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  readonly config: () => TelegramConfig;
  /** 保存配置（绑定 chat 时需要写回）。 */
  readonly saveConfig: (config: TelegramConfig) => Promise<void>;
  readonly log?: (level: 'info' | 'warn', message: string) => void;
}

export interface ImBridgeState {
  running: boolean;
  /** 最近一次错误，给设置页显示。 */
  lastError: string | null;
  /** 已绑定的 chat 数量。 */
  boundChats: number;
  offset: number;
}

export class ImBridge {
  private state: ImBridgeState = { running: false, lastError: null, boundChats: 0, offset: 0 };
  private loop: Promise<void> | null = null;
  private stopped = new AbortController();

  constructor(private readonly options: ImBridgeOptions) {}

  status(): ImBridgeState {
    return { ...this.state, boundChats: this.options.config().chatIds.length };
  }

  /** 启动长轮询。重复调用无副作用。 */
  start(): void {
    if (this.loop) return;
    this.stopped = new AbortController();
    this.state = { ...this.state, running: true, lastError: null };
    this.loop = this.run().finally(() => {
      this.loop = null;
      this.state = { ...this.state, running: false };
    });
  }

  async stop(): Promise<void> {
    this.stopped.abort();
    await this.loop?.catch(() => {});
    this.loop = null;
    this.state = { ...this.state, running: false };
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      try {
        const config = this.options.config();
        if (!config.botToken) {
          await sleep(3000);
          continue;
        }

        const updates = await this.options.client.getUpdates(
          this.state.offset,
          25,
          this.stopped.signal,
        );
        this.state = { ...this.state, lastError: null };

        for (const message of updates.messages) {
          await this.handleMessage(message).catch((error) => {
            this.fail(error);
          });
        }
        for (const callback of updates.callbacks) {
          await this.handleCallback(callback).catch((error) => {
            this.fail(error);
          });
        }

        // offset 必须用真实 update_id 推进：下一轮传 maxUpdateId + 1。
        // 用"处理了几条"来推进会重复处理同一批消息。
        if (updates.maxUpdateId !== null) {
          this.state = { ...this.state, offset: updates.maxUpdateId + 1 };
        }
      } catch (error) {
        if (this.stopped.signal.aborted) break;
        this.fail(error);
        await sleep(3000);
      }
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state = { ...this.state, lastError: message };
    this.options.log?.('warn', `IM 通道异常：${message}`);
  }

  /**
   * 处理一条手机消息。
   *
   * **走的是和 Web 完全相同的 `userSays`**。
   */
  async handleMessage(message: { chatId: string; text: string; fromName: string }): Promise<string | null> {
    const config = this.options.config();
    const text = message.text.trim();

    // 白名单：未绑定的 chat 一律拒绝，并告诉对方该做什么。
    if (!config.chatIds.includes(message.chatId)) {
      // 还没有任何绑定时，第一个发消息的人自动绑定——
      // 省掉让用户手动去查 chat id 的痛苦。
      if (config.chatIds.length === 0) {
        await this.options.saveConfig({ ...config, chatIds: [message.chatId] });
        await this.options.client.sendMessage(
          message.chatId,
          '已绑定这个对话。现在可以直接说要做什么，我会派给项目助理。',
        );
        return null;
      }
      await this.options.client.sendMessage(
        message.chatId,
        '这个对话没有绑定到 OpenCoxswain。请在设置页添加它，或清空绑定后重新绑定。',
      );
      return null;
    }

    if (!config.projectId) {
      await this.options.client.sendMessage(
        message.chatId,
        '还没有绑定项目。请在电脑上的设置页选择一个项目。',
      );
      return null;
    }

    const project = this.options.store.getProject(config.projectId);
    if (!project) {
      await this.options.client.sendMessage(message.chatId, '绑定的项目已不存在，请重新设置。');
      return null;
    }

    // **同一路径**：和 Web 端调的是同一个方法。
    //
    // 注意 `userSays` 是"入队即返回"的（连发不打断）——C 在后台跑。
    // 所以这里记下入队前的消息数，等 C 产生新的回复再取出来发回去。
    const assistantSessionId = project.assistantSessionId;
    const before = this.options.store.messages(assistantSessionId).length;

    await this.options.orchestrator.userSays(project.id, text, { source: 'im:telegram' });

    const reply = await this.waitForReply(assistantSessionId, before);
    if (reply.trim()) {
      await this.options.client.sendMessage(message.chatId, reply);
    }
    return reply;
  }

  /**
   * 等 C 给出新的回复。
   *
   * 超时就返回空——手机上没收到回复比收到一句"还在处理"更糟，
   * 但也不能永远挂着，所以给一个明确的上限并提示。
   */
  private async waitForReply(sessionId: string, beforeCount: number): Promise<string> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const messages = this.options.store.messages(sessionId);
      const fresh = messages
        .slice(beforeCount)
        .filter((m) => m.role === 'assistant' && !isInternalSource(m.source));
      if (fresh.length > 0) {
        return fresh.map((m) => m.content).join('\n\n');
      }
      await sleep(300);
    }
    return '还在处理，稍后到电脑上看，或发「进度」问我。';
  }

  /** 处理按钮点击（审批用）。 */
  async handleCallback(callback: {
    id: string;
    chatId: string;
    data: string;
  }): Promise<void> {
    const [action, id] = callback.data.split(':');
    if (!id || (action !== 'approve' && action !== 'reject')) {
      await this.options.client.answerCallback(callback.id, '未知操作');
      return;
    }

    // 复用同一套审批记录：手机上点和网页上点，效果完全一样。
    const result =
      action === 'approve'
        ? await approveAction(this.options.store, id, '通过手机批准')
        : await rejectAction(this.options.store, id, '通过手机拒绝');

    await this.options.client.answerCallback(callback.id, result.message);
  }

  /** 危险动作需审批时推到手机。 */
  async notifyApproval(approvalId: string, category: string, evidence: string): Promise<void> {
    const config = this.options.config();
    if (!config.botToken || config.chatIds.length === 0) return;

    const text = [
      `⚠ 有个${labelOf(category)}动作等你批准`,
      `\`${escapeMarkdown(evidence)}\``,
      '',
      '未批准之前不会执行。',
    ].join('\n');

    for (const chatId of config.chatIds) {
      await this.options.client
        .sendMessage(chatId, text, [
          [
            { text: '拒绝', data: `reject:${approvalId}` },
            { text: '批准执行', data: `approve:${approvalId}` },
          ],
        ])
        .catch(() => {});
    }
  }

  /** D 有结论时要人看，推到手机。 */
  async notifyReport(body: string, needsUser: boolean): Promise<void> {
    const config = this.options.config();
    if (!config.botToken || config.chatIds.length === 0) return;

    const header = needsUser ? '🔔 需要你决定' : '✅ 有结果了';
    for (const chatId of config.chatIds) {
      await this.options.client
        .sendMessage(chatId, `${header}\n\n${truncate(body, 3000)}`)
        .catch(() => {});
    }
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  delete: '删除',
  push: '推送',
  publish: '发布',
  pay: '付款',
  external_send: '对外发送',
};

function labelOf(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

/** Telegram Markdown 里这几个字符必须转义，否则消息会被拒。 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
