import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ExecutorDto, MessageDto, ProjectDto } from '../api.js';
import { renderMarkdown } from './Markdown.js';
import { MessageActions } from './MessageActions.js';
import { useAutoScroll } from './useAutoScroll.js';
import { TraceView } from './TraceView.js';
import { BatchBlock } from './BatchBlock.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { attachmentsToText, imageParts, useAttachments } from './attachments.js';
import { groupBatches, isNotableBatch, type Batch } from './batches.js';
import { editableText } from './messageCapabilities.js';
import { describeContext, formatTokens } from './contextUsage.js';
import { IconBrand, IconChevron, IconPlus, IconSend, IconSidebar } from './icons.js';
import { buildStatus } from './statusMetrics.js';
import { PermissionPicker } from './PermissionPicker.js';
import { describeWait } from './waitStatus.js';
import { composerHint } from './composerHint.js';
import { Onboarding } from './Onboarding.js';
import { shouldShowOnboarding } from './starterGuide.js';
import { clearDraft, loadDraft, saveDraft } from '../drafts.js';
import { MentionPicker, applyMention, detectMention, type MentionState } from './MentionPicker.js';
import type { ApiClient } from '../api.js';

export interface ConversationProps {
  readonly project: ProjectDto;
  /**
   * 项目选择器（照 DSH）。
   *
   * 用户指出"新会话"和"添加项目"作用完全一样。DSH 的做法是：
   * 新建项目不再是顶部导航项，而是**新会话输入框旁边的选择器**里的一个动作。
   */
  readonly projectPicker?: React.ReactNode;
  readonly messages: readonly MessageDto[];
  readonly thinking: boolean;
  /** 记忆候选审阅区（可折叠），放在顶部。 */
  readonly memoryReview?: React.ReactNode;
  /** 模板选择器，放在输入框下方。 */
  readonly templatePicker?: React.ReactNode;
  /** 轨迹页用的完整消息（含内部通知）；不给就用 messages。 */
  readonly traceMessages?: readonly MessageDto[];
  /** 当前项目的 Agent 列表，用来画批次线。 */
  readonly executors?: readonly ExecutorDto[];
  /** 点批次里的某个 Agent → 打开它的对话。 */
  readonly onOpenExecutor?: (executorId: string) => void;
  /** 底部状态栏的汇总指标（照 DSH 的一行指标）。 */
  readonly stats?: {
    readonly turns: number;
    readonly steps: number;
    readonly tokensPerSecond: string;
    readonly totalTokens: string;
    readonly cacheHit: string;
  };
  /** 外部注入的草稿（模板填入用）；变化时覆盖输入框。 */
  readonly draftSeed?: { readonly text: string; readonly at: number };
  /**
   * 发送消息。
   *
   * 第二个参数是图片附件——**只有图片走这里**，文本文件的内容已经
   * 由调用方拼进 text 了。
   */
  readonly onSend: (text: string, images?: readonly { type: 'image'; dataUrl: string; name: string }[]) => void;
  readonly onStop: () => void;
  /**
   * 右侧栏的开关。
   *
   * 用户反馈：「目前关闭之后就不知道在哪里打开了，参考 DSH 吧」。
   *
   * DSH 在对话区标题行**最右边**放一个常驻按钮：展开时是高亮的分栏图标，
   * 关闭时是灰的。位置固定，收起来也永远看得见。
   */
  readonly railOpen?: boolean;
  readonly onToggleRail?: () => void;
  /** 草稿键：不同视图各自一份。 */
  readonly draftKey: string;
  /** API 客户端（@ 引用要查文件列表）。 */
  readonly api: ApiClient;
}

/**
 * 与Assistant 的对话。
 *
 * 这里**只显示人和 C 说的话**。Agent 的一切（结算通知、工具调用、
 * 原始产出）都不进来——它们在左侧导航里各自的对话中。
 *
 * 输入框**从不被禁用**：C 还在回复时用户依然可以继续发（连发不打断）。
 */
export function Conversation(props: ConversationProps): JSX.Element {
  // 草稿：按视图分开存，切换项目再回来内容还在
  const draftKey = props.draftKey;
  const [draft, setDraft] = useState(() => loadDraft(draftKey));

  /** 改草稿并落盘。空内容会自动删键（见 drafts.ts）。 */
  const updateDraft = useCallback(
    (text: string) => {
      setDraft(text);
      saveDraft(draftKey, text);
    },
    [draftKey],
  );

  // 切换视图时换一份草稿——不能把上一个项目的半句话带过来
  useEffect(() => {
    setDraft(loadDraft(draftKey));
  }, [draftKey]);
  // 首次引导：只在没看过时显示，点过就再也不出现
  const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);

  // @ 引用：输入框里打 @ 时弹出文件选择
  const [mention, setMention] = useState<MentionState>({ active: false, query: '', start: -1 });

  // 批次：同一轮派出的 Agent 归到一起（签名元素）
  const allBatches = useMemo(() => groupBatches(props.executors ?? []), [props.executors]);
  /** 当前标签页：对话 / 轨迹（照 DSH）。 */
  const [tab, setTab] = useState<'chat' | 'trace'>('chat');
  /** 上下文预警横幅是否已被用户关掉。 */
  const [dismissedBanner, setDismissedBanner] = useState(false);

  // 附件：拖入 / 粘贴 / 选择
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  // 轨迹条数（标签上的小数字）
  const traceCount = (props.traceMessages ?? props.messages).filter((m) => !m.internal).length;

  // 模板填入：只在 seed 变化时覆盖一次，不干扰用户后续输入。
  const lastSeed = useRef<number>(0);
  useEffect(() => {
    if (!props.draftSeed || props.draftSeed.at === lastSeed.current) return;
    lastSeed.current = props.draftSeed.at;
    setDraft(props.draftSeed.text);
  }, [props.draftSeed]);

  const visible = props.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.internal,
  );

  // 会话身份：切项目/切会话时强制滚到底部。
  const scrollIdentity = `${props.project.id}:${props.draftKey}`;
  const scroll = useAutoScroll(visible.length, scrollIdentity);

  const submit = (): void => {
    const text = draft.trim();
    const hasAttachments = attachments.attachments.length > 0;

    // 允许**只发附件不发文字**——拖一张截图就发是很自然的动作
    if (!text && !hasAttachments) return;

    // 把附件拼进消息：
    // - 文本文件的内容直接注入（让模型真的读到）
    // - 图片单独传（走多模态通道，由协议层决定发不发）
    const attachmentText = attachmentsToText(attachments.attachments);
    const fullText = [text, attachmentText].filter(Boolean).join('\n\n');

    props.onSend(fullText || '（见附件）', imageParts(attachments.attachments));

    // 发出去就把草稿清掉，不然下次进来会看到已经发过的内容
    setDraft('');
    clearDraft(draftKey);
    attachments.clear();
  };

  /**
   * 上下文用量预警。
   *
   * 用量按消息字符估算——**不追求精确**，只需要「是不是快满了」这个判断。
   * 压缩次数从轨迹里的压缩记录数出来（source === 'compaction'）。
   */
  const contextUsage = useMemo(() => {
    let chars = 0;
    for (const message of props.messages) {
      chars += message.content.length;
    }
    // 粗略换算：中文约 1 字/token，英文约 4 字符/token。取中间值 2.5 字符/token
    const used = Math.round(chars / 2.5);

    const compactions = (props.traceMessages ?? []).filter(
      (m) => m.source === 'compaction',
    );

    // **只在刚压缩完的两分钟内提示一次**。
    //
    // 之前是"压过一次就永久提示"——长任务必然压缩（实测 40 次），
    // 那条提示于是常驻在输入框上方，变成一整行没人读的装饰。
    //
    // 现在压缩后短暂提示，用户知道"刚才发生了什么"；
    // 之后只留状态栏的百分比，需要细节时自己去状态栏看。
    const recentlyCompacted = compactions.some((m) => Date.now() - m.at < 2 * 60_000);

    return describeContext(used, {
      compactionCount: compactions.length,
      recentlyCompacted,
    });
  }, [props.messages, props.traceMessages]);

  /** 状态栏的三组指标：工作量 / 性能 / 上下文。 */
  const statusGroups = useMemo(
    () =>
      buildStatus({
        turns: props.stats?.turns ?? 0,
        steps: props.stats?.steps ?? 0,
        ...(props.stats?.tokensPerSecond !== undefined
          ? { tokensPerSecond: props.stats.tokensPerSecond }
          : {}),
        ...(props.stats?.totalTokens !== undefined
          ? { totalTokens: props.stats.totalTokens }
          : {}),
        ...(props.stats?.cacheHit !== undefined ? { cacheHit: props.stats.cacheHit } : {}),
        contextRatio: contextUsage.ratio,
        contextUsed: formatTokens(contextUsage.used),
        contextLimit: formatTokens(contextUsage.limit),
      }),
    [props.stats, contextUsage],
  );

  /**
   * 等待状态：从开始思考的那一刻计时。
   *
   * 每秒刷新一次——**这本身就是信息**：秒数在走，说明程序活着，
   * 不是卡死了。
   */
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!props.thinking) {
      setWaitStartedAt(null);
      return;
    }
    // 开始思考：记下起点
    setWaitStartedAt((prev) => prev ?? Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.thinking]);

  /** 输入区提示：Agent 在跑时告诉用户可以继续说。 */
  const hint = composerHint({
    thinking: props.thinking,
    runningAgents: (props.executors ?? []).filter(
      (e) => e.status === 'running' || e.status === 'starting',
    ).length,
  });

  const waitStatus = useMemo(() => {
    const elapsed = waitStartedAt === null ? 0 : now - waitStartedAt;
    const runningAgents = (props.executors ?? []).filter(
      (e) => e.status === 'running' || e.status === 'starting',
    ).length;
    return describeWait(elapsed, { runningAgents });
  }, [waitStartedAt, now, props.executors]);

  return (
    <div className="conversation">
      {/* 标题行照 DSH：标题 + 状态标签 + 右侧操作 */}
      <header className="conversation-header">
        <div className="header-main">
          <h2>{props.project.name}</h2>
          <span className="header-badge">Agent 模式</span>
        </div>
        <div className="header-side">
          <span className="muted small" title={props.project.displayPath}>
            {props.project.displayPath}
          </span>
          {/* **侧边栏开关：常驻在标题行最右边**。
              之前右栏只能从里面的 ✕ 关掉，关掉后没有任何入口再打开。
              DSH 的做法就是这个位置放一个固定按钮，
              展开时高亮、收起时灰——位置不变，永远找得到。 */}
          {props.onToggleRail && (
            <button
              type="button"
              className={`btn btn--ghost btn--sm btn--icon rail-toggle${props.railOpen ? ' active' : ''}`}
              onClick={props.onToggleRail}
              title={props.railOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-pressed={props.railOpen}
            >
              <IconSidebar size={16} />
            </button>
          )}
        </div>
      </header>

      {/* 标签页：对话 / 轨迹（照 DSH） */}
      <div className="view-tabs" role="tablist">
        <button
          type="button"
          className={`btn btn--ghost btn--md view-tab${tab === 'chat' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'chat'}
          onClick={() => setTab('chat')}
        >
          对话
        </button>
        <button
          type="button"
          className={`btn btn--ghost btn--md view-tab${tab === 'trace' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'trace'}
          onClick={() => setTab('trace')}
        >
          轨迹
          {traceCount > 0 && <span className="view-tab-count">{traceCount}</span>}
        </button>
        <span className="view-tab-more" aria-hidden>⋯</span>
      </div>

      {tab === 'trace' ? (
        <TraceView messages={props.traceMessages ?? props.messages} />
      ) : (
        <>
          {props.memoryReview}

          <div className="messages" ref={scroll.ref}>
        {visible.length === 0 && (
          /* **空会话是欢迎页，不是一块提示卡。**
             之前是左上角一个小卡片（"直接说要做什么…"），
             看起来像"出错了的占位块"，而不是"欢迎使用"。
             照 DSH：居中大标语 + 输入框在下，安静、有份量。 */
          <div className="welcome">
            <div className="welcome-brand">
              <IconBrand size={36} />
              <h1>从这里开始</h1>
            </div>
            <p className="welcome-sub">
              说一句想做的事，我会拆给 Agent 去干；也可以连续发，不会打断。
            </p>
            <div className="welcome-examples">
              <span>试试：</span>
              <button type="button" className="welcome-example" onClick={() => {
                updateDraft('查一下这个项目的目录结构（只读）');
              }}>
                查一下项目结构（只读）
              </button>
              <button type="button" className="welcome-example" onClick={() => {
                updateDraft('给最近改动的功能补测试');
              }}>
                给最近改动的功能补测试
              </button>
              <button type="button" className="welcome-example" onClick={() => {
                updateDraft('把这段逻辑重构成组件');
              }}>
                重构一段逻辑
              </button>
            </div>
          </div>
        )}

        {visible.map((message, index) => {
          const prev = visible[index - 1];
          const showTime = shouldShowTime(prev, message);
          // 这一条之后要插入的批次：按派出时间落在两条消息之间
          const here = batchesBetween(message, visible[index + 1], allBatches);
          return (
            <div key={message.id}>
              {showTime && <div className="time-divider">{formatTime(message.at)}</div>}
              <Message
                message={message}
                onResend={(text) => props.onSend(text)}
                onRetry={() => {
                  // 重试：找到这条回答对应的那条用户消息，原样再发一次。
                  //
                  // **不删除历史**——这个产品承诺"轨迹可回看"，
                  // 静默删掉之前的回答就等于毁掉了"它当时怎么答的"这个证据。
                  // 所以表现是追加一次新尝试。
                  const idx = visible.indexOf(message);
                  for (let i = idx - 1; i >= 0; i -= 1) {
                    const prevMessage = visible[i];
                    if (prevMessage?.role === 'user') {
                      props.onSend(prevMessage.content);
                      break;
                    }
                  }
                }}
                onEdit={(_id, text) => updateDraft(text)}
              />
              {here.map((batch) => (
                <BatchBlock
                  key={batch.id}
                  batch={batch}
                  onOpen={(id) => props.onOpenExecutor?.(id)}
                />
              ))}
            </div>
          );
        })}

        {/* 最后一条之后可能还有批次（刚派出去、还没回复） */}
        {batchesBetween(visible[visible.length - 1], undefined, allBatches).map((batch) => (
          <BatchBlock
            key={batch.id}
            batch={batch}
            onOpen={(id) => props.onOpenExecutor?.(id)}
          />
        ))}

        {props.thinking && (
          <div className="message assistant">
            <span className="msg-role">Assistant</span>
            <div className="bubble">
              {/* 说出**在等什么、等了多久**，而不是三个跳动的点。
                  用户能看到"现在是真的在干活"还是"可能卡住了"。 */}
              <div className={`waiting level-${waitStatus.level}`}>
                <span className="waiting-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="waiting-text">{waitStatus.text}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 输入区照 DSH：浮在底部的大框，内含工具栏 + 圆形发送 */}
      <div
        className={`composer${attachments.dragging ? ' dragging' : ''}`}
        // 拖入：整个输入区都是投放目标，不用精确瞄准
        onDragOver={(e) => {
          e.preventDefault();
          attachments.setDragging(true);
        }}
        onDragLeave={(e) => {
          // 只有真的离开输入区才取消，避免掠过子元素时闪烁
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            attachments.setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          attachments.setDragging(false);
          void attachments.add(e.dataTransfer.files);
        }}
      >
        {attachments.dragging && <div className="drop-hint">松手添加附件</div>}

        {/* 在跑时告诉用户可以继续说——这个能力一直有，但界面没说过 */}
        {hint && <div className={`composer-hint tone-${hint.tone}`}>{hint.text}</div>}

        {/* @ 引用：输入 @ 后弹出文件选择器 */}
        {mention.active && (
          <MentionPicker
            api={props.api}
            projectId={props.project.id}
            query={mention.query}
            onPick={(file) => {
              // 把 @xxx 替换成 @完整路径，并关闭选择器
              updateDraft(applyMention(draft, mention, file.path));
              setMention({ active: false, query: '', start: -1 });
            }}
            onClose={() => setMention({ active: false, query: '', start: -1 })}
          />
        )}

        {/* **回到底部：挂在输入区上沿之外**，不挡消息内容。
            跟着输入区走，输入框多高都不会压到内容。 */}
        {!scroll.atBottom && (
          <button
            type="button"
            className={`jump-bottom${scroll.unread > 0 ? ' has-unread' : ''}`}
            onClick={scroll.scrollToBottom}
            title={scroll.unread > 0 ? `${scroll.unread} 条新消息` : '回到底部'}
            aria-label={scroll.unread > 0 ? `${scroll.unread} 条新消息` : '回到底部'}
          >
            {scroll.unread > 0 ? <span>{scroll.unread}</span> : <IconChevron size={14} direction="down" />}
          </button>
        )}

        <div className="composer-box">
          {props.projectPicker && (
            <div className="composer-picker-row">{props.projectPicker}</div>
          )}
          <AttachmentStrip attachments={attachments.attachments} onRemove={attachments.remove} />

          <textarea
            value={draft}
            placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话（可拖入文件）"
            onChange={(e) => {
              updateDraft(e.target.value);
              // 判断是否在输入 @ 引用
              const caret = e.target.selectionStart ?? e.target.value.length;
              setMention(detectMention(e.target.value, caret));
            }}
            onPaste={(e) => {
              // 粘贴截图：直接从剪贴板取文件。这是最高频的附件入口。
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                void attachments.add(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
          />
          <div className="composer-bar">
            <div className="composer-left">
              {/* **权限随时可调**（照 DSH）：不用去设置页来回切 */}
              <PermissionPicker api={props.api} projectId={props.project.id} />
              {/* 选择文件：拖入和粘贴之外的第三条路，
                  也是唯一对不习惯拖拽的用户友好的入口 */}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                title="添加附件（也可以直接拖入或粘贴）"
                onClick={() => fileInput.current?.click()}
              >
                <IconPlus size={14} />
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void attachments.add(e.target.files);
                  // 清空 value，否则选同一个文件第二次不会触发 change
                  e.target.value = '';
                }}
              />
              {props.templatePicker}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={props.onStop}
                title="停止当前这轮"
              >
                停止
              </button>
            </div>
            {/* **不套 btn 系统**：通用按钮是胶囊/矩形语义，
                套上去会得到 40×26 的椭圆。
                .send-btn 自己保证宽高相等 → 正圆。 */}
            <button
              type="button"
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="发送"
              title="发送（Enter）"
            >
              <IconSend size={16} />
            </button>
          </div>
        </div>
      </div>
        </>
      )}

      {/* 首次引导：**不依赖对话是否为空**——已经有历史的用户更需要
          知道"还能怎么用"，而之前那版只在空对话显示，老用户永远看不到。 */}
      {showOnboarding && (
        <Onboarding
          onPick={(prompt) => {
            setShowOnboarding(false);
            props.onSend(prompt);
          }}
          onDismiss={() => setShowOnboarding(false)}
        />
      )}

      {/* 上下文预警：只在 near / 刚压缩过时出现，且可以关掉。
          ok 档不显示——每次都提示"上下文正常"比不提示更烦人。

          为什么加关闭按钮：压缩后有提示是有用的（用户想知道"前面的内容为什么没了"），
          但它不该常驻。长任务会反复压缩，永久横幅会变成一整行没人读的装饰。 */}
      {contextUsage.message && !dismissedBanner && (
        <div className={`context-banner level-${contextUsage.level}`}>
          <span className="context-banner-icon" aria-hidden>
            {contextUsage.level === 'compacted' ? 'ⓘ' : '⚠'}
          </span>
          <span className="context-banner-text">{contextUsage.message}</span>
          <button
            type="button"
            className="btn btn--link context-banner-close"
            title="知道了，不再显示"
            onClick={() => setDismissedBanner(true)}
          >
            知道了
          </button>
        </div>
      )}

      {/* 底部状态栏：**每个数字都有标签和口径**。
          之前是一排裸数字（225 轮 · 319 步 / 173 tok/s / 2.196M tok /
          缓存命中 91% / 39%），用户读不出任何结论，也不知道哪个能动作。

          现在分三组：工作量 → 性能 → 上下文。
          调试类指标（缓存命中）默认不显示——用户看了无法行动。 */}
      <footer className="status-bar">
        {statusGroups.map((group, groupIndex) => (
          <span key={group.id} className="status-group">
            {groupIndex > 0 && <span className="status-sep" aria-hidden />}
            {group.metrics.map((metric) => (
              <span
                key={metric.id}
                className={`status-item${metric.id === 'context' ? ` level-${contextUsage.level}` : ''}`}
                title={metric.detail}
              >
                <span className="status-label">{metric.label}</span>
                <span className="status-value">{metric.value}</span>
              </span>
            ))}
          </span>
        ))}
      </footer>
    </div>
  );
}

function Message({
  message,
  onResend,
  onRetry,
  onEdit,
}: {
  message: MessageDto;
  onResend?: (text: string) => void;
  onRetry?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      {/* 角色标签取代头像：桌面软件不用圆形头像，用一行小字 */}
      <span className="msg-role">{isUser ? '你' : 'Assistant'}</span>
      <div className="bubble">
        {/* 历史消息里的图片：刷新后还能看到自己发过的图 */}
        {(message.images ?? []).length > 0 && (
          <div className="bubble-images">
            {(message.images ?? []).map((img, i) => (
              <img
                key={`${message.id}-img-${i}`}
                className="bubble-image"
                src={img.dataUrl}
                alt={img.name ?? '图片'}
                title={img.name}
              />
            ))}
          </div>
        )}
        {message.content && renderMarkdown(message.content)}
        <div className="bubble-footer">
          <MessageActions
            content={message.content}
            role={message.role}
            {...(message.source ? { source: message.source } : {})}
            {...(onRetry && !isUser ? { onRetry: () => onRetry(message.id) } : {})}
            {...(onEdit && isUser ? { onEdit: () => onEdit(message.id, editableText(message.content)) } : {})}
            {...(isUser && onResend ? { onResend: () => onResend(message.content) } : {})}
          />
        </div>
      </div>
    </div>
  );
}

/** 隔 5 分钟才显示一次时间，避免每条都顶一行。 */
function shouldShowTime(prev: MessageDto | undefined, current: MessageDto): boolean {
  if (!prev) return true;
  return current.at - prev.at > 5 * 60_000;
}

/**
 * 找出落在两条消息之间的批次。
 *
 * 批次代表「这一轮派出去的 Agent」，时间点是第一个 Agent 的创建时间。
 * 落在 `(after.at, before.at]` 区间内就显示在这里。
 * **单条 Agent 的批次不画**——那是普通派活，不需要强调「批」。
 */
function batchesBetween(
  after: MessageDto | undefined,
  before: MessageDto | undefined,
  allBatches: readonly Batch[],
): readonly Batch[] {
  if (!after) return [];
  const end = before?.at ?? Number.POSITIVE_INFINITY;
  return allBatches.filter((b) => isNotableBatch(b) && b.at > after.at && b.at <= end);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
