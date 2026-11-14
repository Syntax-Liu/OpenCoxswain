/**
 * 与运行时通信的客户端。
 *
 * 两条通道：
 * 1. **REST**：拉快照（项目、消息、Agent、汇报）与发指令（说话、停止、取消）。
 * 2. **SSE**：接收增量事件。
 *
 * 快照 + 增量是本设计的关键：
 * - 连上时先拉一次快照，界面立刻有内容；
 * - 之后只靠 SSE 增量更新；
 * - 断线重连时带 `after=<最后收到的 seq>`，服务端补发错过的；
 * - 若收到 `gap` 事件，说明错过太多，**重拉快照**而不是继续拼增量。
 */

export type ExecutorStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly displayPath: string;
  readonly assistantSessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly running?: number;
  readonly needsUser?: number;
}

export interface ExecutorDto {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly goal: string;
  /** 只读Agent不参与写域互斥，可与他人并行。 */
  readonly access?: 'readwrite' | 'readonly';
  readonly writeScope: readonly string[];
  readonly status: ExecutorStatus;
  readonly summary: string | null;
  readonly blockedReason: string | null;
  /** 运行指标（不做计费，只反映真实用量）。 */
  readonly metrics?: RunMetricsDto;
  /** 系统复核结果。未声明验收标准时为 null。 */
  readonly acceptance?: AcceptanceDto | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

export interface CriterionResultDto {
  readonly criterion: { readonly id: string; readonly desc: string; readonly type: string };
  readonly verdict: 'passed' | 'failed' | 'unverified';
  readonly note: string;
  readonly output?: string;
}

export interface AcceptanceDto {
  readonly verdict: 'passed' | 'failed' | 'unverified';
  readonly results: readonly CriterionResultDto[];
  readonly needsHuman: boolean;
}

export interface RunMetricsDto {
  readonly turns: number;
  readonly steps: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cachedTokens: number | null;
  readonly durationMs: number;
  /**
   * 模型调用累计耗时。`tok/s` 要用它算——用 durationMs 算出来的是
   * 任务整体吞吐，含工具执行时间，会明显偏低。
   *
   * 老数据没有这个字段。
   */
  readonly modelMs?: number | null;
  readonly contextTokens: number | null;
}

export interface UsageDto {
  readonly guard: { perTask?: number; perDay?: number } | null;
  readonly today: { tokensIn: number; tokensOut: number };
  readonly all: { tokensIn: number; tokensOut: number };
  readonly totals: {
    turns: number;
    steps: number;
    tokensIn: number;
    tokensOut: number;
    cachedTokens: number | null;
  };
  readonly todayRuns: number;
}

/** @ 引用用的文件条目。 */
/** 全文搜索的一条结果。 */
export interface SearchHitDto {
  readonly messageId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: string;
  readonly snippet: string;
  readonly at: number;
  readonly projectName: string;
  readonly sessionLabel: string;
  /** 所属 Agent 的 id；Assistant 的会话为 null。 */
  readonly executorId: string | null;
}

export interface FileEntryDto {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface MessageDto {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly source: string;
  readonly at: number;
  /** 图片附件（用户拖入或粘贴的图）；刷新后用于显示缩略图。 */
  readonly images?: ReadonlyArray<{ type: 'image'; dataUrl: string; name?: string }>;
  /**
   * 是否是系统内部通知（如Agent结算）。
   *
   * 这类消息进入 Assistant 的上下文，但**不该显示在用户的对话流里**——
   * 它是给模型的指令，不是用户说的话。
   */
  readonly internal?: boolean;
}

export interface ReportDto {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string | null;
  readonly kind: 'progress' | 'blocked' | 'done' | 'failed' | 'question';
  readonly body: string;
  readonly needsUser: boolean;
  readonly at: number;
  readonly ackedAt: number | null;
}

export type RuntimeEventDto =
  | { readonly type: 'assistant_text'; readonly projectId: string; readonly text: string }
  | { readonly type: 'executor_started'; readonly projectId: string; readonly executor: ExecutorDto }
  | {
      readonly type: 'executor_queued';
      readonly projectId: string;
      readonly executor: ExecutorDto;
      readonly reason: string;
    }
  | {
      readonly type: 'executor_settled';
      readonly projectId: string;
      readonly executor: ExecutorDto;
      readonly ok: boolean;
    }
  | { readonly type: 'report'; readonly projectId: string; readonly report: ReportDto }
  | {
      readonly type: 'turn_judged';
      readonly projectId: string;
      readonly turnId: string;
      readonly judged: 'new' | 'parallel' | 'conflict';
      readonly reason: string;
    }
  | { readonly type: 'gap'; readonly reason: string };

export interface OutboundEvent {
  readonly seq: number;
  readonly at: number;
  readonly event: RuntimeEventDto;
}

export interface SettingsStatus {
  readonly configured: boolean;
  /** 密钥存储形态：密文还是明文。 */
  readonly storage?: 'encrypted' | 'plaintext';
  readonly source: 'env' | 'file' | 'none';
  readonly baseUrl: string;
  readonly model: string;
}

export interface ApprovalDto {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string;
  readonly category: string;
  readonly evidence: string;
  readonly why: string;
  readonly tool: string;
  readonly args: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly decidedReason: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly expiresAt: number;
}

export interface SideEffectDto {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string;
  readonly kind: 'fs.write' | 'fs.delete' | 'proc.exec' | 'net.send';
  readonly target: string;
  readonly state: 'pending' | 'succeeded' | 'failed' | 'rejected' | 'undone';
  readonly reversible: boolean;
  readonly tool: string;
  readonly args: string;
  readonly note: string | null;
  readonly createdAt: number;
  readonly settledAt: number | null;
}

export interface MemoryCandidateDto {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'profile' | 'project' | 'decision' | 'lesson';
  readonly scope: 'global' | 'project';
  readonly text: string;
  readonly source: string;
  readonly status: 'pending' | 'accepted' | 'dismissed';
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface ImStatusDto {
  readonly enabled: boolean;
  readonly hasToken: boolean;
  readonly chatIds: readonly string[];
  readonly projectId: string | null;
  readonly status: {
    readonly running: boolean;
    readonly lastError: string | null;
    readonly boundChats: number;
  } | null;
}

export interface UpdateCheckDto {
  readonly available: boolean;
  readonly version?: string;
  readonly notes?: string;
  readonly currentVersion: string;
  readonly checkedAt: number;
}

export interface TaskTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly whenToUse: string;
  readonly writeScope: readonly string[];
  readonly policy: string;
  readonly readonly?: boolean;
}

export interface AppliedTemplateDto {
  readonly templateId: string;
  readonly label: string;
  readonly goal: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly unknown[];
  readonly policy: string;
  readonly readonly: boolean;
  /** 永远是 true：模板只预填，不自动派活。 */
  readonly requiresConfirmation: true;
}

export interface ModelParamsDto {
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly contextLength?: number;
  readonly supportsImages?: boolean;
  readonly maxToolRounds?: number;
  readonly temperature?: number;
  readonly topP?: number;
}

export interface ModelConfigDto {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly params: ModelParamsDto;
}

export interface ModelSettingsDto {
  readonly models: readonly ModelConfigDto[];
  readonly roles: {
    readonly supervisor: string | null;
    readonly assistant: string | null;
    readonly agent: string | null;
  };
}

export interface PermissionLevelDto {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 本机访问令牌由运行时在首屏注入；没有就不带（服务端会拒绝）。 */
export function readToken(): string {
  const injected = (window as unknown as { __OCX_TOKEN__?: unknown }).__OCX_TOKEN__;
  return typeof injected === 'string' ? injected : '';
}

export class ApiClient {
  constructor(private readonly baseUrl = '') {}

  /**
   * 本机访问令牌。
   *
   * 由运行时在首屏注入（`window.__OCX_TOKEN__`）。
   * 没有令牌时所有 API 请求都会被拒——这是故意的：
   * 之前任意网页都能跨源调这个 API。
   */
  private token(): string {
    return readToken();
  }


  private async request<T>(
    path: string,
    init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown },
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${this.token()}`,
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `请求失败（HTTP ${response.status}）`;
      throw new ApiError(response.status, message);
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; lastSeq: number }> {
    return this.request('/api/health');
  }

  /** 模型密钥状态（不返回密钥本身）。 */
  settings(): Promise<SettingsStatus> {
    return this.request('/api/settings');
  }

  /** 保存密钥。**保存后立即生效**，不需要重启。 */
  saveSettings(input: { apiKey: string; baseUrl?: string; model?: string }): Promise<SettingsStatus> {
    return this.request('/api/settings', {
      method: 'POST',
      body: {
        apiKey: input.apiKey,
        baseUrl: input.baseUrl ?? '',
        model: input.model ?? '',
      },
    });
  }

  clearSettings(): Promise<SettingsStatus> {
    return this.request('/api/settings', { method: 'DELETE' });
  }

  listProjects(): Promise<{ projects: ProjectDto[]; lastSeq: number }> {
    return this.request('/api/projects');
  }

  openProject(input: { rootPath: string; name?: string }): Promise<{ project: ProjectDto }> {
    return this.request('/api/projects', {
      method: 'POST',
      body: { rootPath: input.rootPath, ...(input.name ? { name: input.name } : {}) },
    });
  }

  projectDetail(id: string): Promise<{
    project: ProjectDto;
    executors: ExecutorDto[];
    reports: ReportDto[];
    lastSeq: number;
  }> {
    return this.request(`/api/projects/${encodeURIComponent(id)}`);
  }

  messages(projectId: string): Promise<{ messages: MessageDto[]; lastSeq: number }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/messages`);
  }

  /** 把项目移出工作区（归档，**不删磁盘文件**）。有 Agent 在跑时返回 409。 */
  archiveProject(projectId: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
      method: 'DELETE',
    });
  }

  /**
   * 把一条待决策标记为已处理。
   *
   * **不是删除**——记录留着，用户能回头查当时怎么决定的。
   */
  acknowledgeReport(reportId: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/reports/${encodeURIComponent(reportId)}/ack`, { method: 'POST' });
  }

  /** 撤销一次文件写入。只有文件写入可撤销。 */  undoEffect(effectId: string, projectId: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/side-effects/${encodeURIComponent(effectId)}/undo`, {
      method: 'POST',
      body: { projectId },
    });
  }

  /** 全文搜索消息内容。 */
  search(query: string, projectId?: string): Promise<{ hits: SearchHitDto[] }> {
    const params = new URLSearchParams({ q: query });
    if (projectId) params.set('projectId', projectId);
    return this.request(`/api/search?${params.toString()}`);
  }

  /** 列出项目文件（@ 引用用）。query 为空时返回前 40 个。 */
  listFiles(
    projectId: string,
    query: string,
  ): Promise<{ files: FileEntryDto[]; total: number; truncated: boolean }> {
    const q = query ? `?q=${encodeURIComponent(query)}` : '';
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/files${q}`);
  }

  /** 读一个文件的内容（@ 引用选中后注入上下文）。 */
  readFile(projectId: string, filePath: string): Promise<{ path: string; content: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
    );
  }

  /** 对 Assistant 说话。**立刻返回**，Assistant 的回复通过 SSE 到达。 */
  say(
    projectId: string,
    text: string,
    images?: readonly { type: 'image'; dataUrl: string; name: string }[],
  ): Promise<{ accepted: boolean }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/say`, {
      method: 'POST',
      body: {
        text,
        source: 'webapp',
        // 图片单独传：运行时据此构造多模态消息。
        // 不传时行为与以前完全一致。
        ...(images && images.length > 0 ? { images } : {}),
      },
    });
  }

  stop(projectId: string): Promise<{ stopped: boolean }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/stop`, {
      method: 'POST',
    });
  }

  cancelExecutor(executorId: string): Promise<{ ok: boolean; content: string }> {
    return this.request(`/api/executors/${encodeURIComponent(executorId)}/cancel`, {
      method: 'POST',
    });
  }

  /** "打开原会话"：Agent 的完整记录（含每次工具调用）。 */
  executorMessages(executorId: string): Promise<{
    executor: ExecutorDto;
    session: unknown;
    messages: MessageDto[];
  }> {
    return this.request(`/api/executors/${encodeURIComponent(executorId)}/messages`);
  }

  /** 用户直接对某个 Agent 追问：它带着原上下文继续。 */
  sayToExecutor(executorId: string, text: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/executors/${encodeURIComponent(executorId)}/say`, {
      method: 'POST',
      body: { text },
    });
  }

  /** 项目用量统计（不做计费，只呈现真实 token 数字）。 */
  usage(projectId: string): Promise<UsageDto> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/usage`);
  }

  /** 某个 Agent的副作用台账：它到底改了什么。 */
  executorEffects(executorId: string): Promise<{ effects: SideEffectDto[] }> {
    return this.request(`/api/executors/${encodeURIComponent(executorId)}/effects`);
  }

  /** 记忆候选列表。 */
  memories(projectId: string): Promise<{ candidates: MemoryCandidateDto[]; pending: number }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/memories`);
  }

  /** 触发一次记忆提炼。提炼出的是候选，不直接生效。 */
  extractMemories(
    projectId: string,
  ): Promise<{ created: number; rejected: number; candidates: MemoryCandidateDto[] }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/memories`, {
      method: 'POST',
    });
  }

  acceptMemory(candidateId: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/memories/${encodeURIComponent(candidateId)}/accept`, {
      method: 'POST',
    });
  }

  dismissMemory(candidateId: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/memories/${encodeURIComponent(candidateId)}/dismiss`, {
      method: 'POST',
    });
  }

  /** 删除一条会话（Agent）。正在跑的会被服务端拒绝。 */
  deleteExecutor(executorId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/executors/${encodeURIComponent(executorId)}`, { method: 'DELETE' });
  }

  /** 多模型配置。 */
  models(): Promise<{ settings: ModelSettingsDto; storage: string }> {
    return this.request('/api/models');
  }

  saveModels(settings: {
    models: readonly ModelConfigDto[];
    roles: ModelSettingsDto['roles'];
  }): Promise<{ ok: boolean; storage: string }> {
    return this.request('/api/models', { method: 'POST', body: settings });
  }

  /** 权限档位。 */
  permissions(projectId?: string): Promise<{
    settings: {
      level: string;
      projects: Readonly<Record<string, string>>;
      /** 传了 projectId 时，这个项目**实际生效**的档位。 */
      effective: string;
    };
    levels: readonly PermissionLevelDto[];
  }> {
    const q = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    return this.request(`/api/permissions${q}`);
  }

  /**
   * 改权限档位。
   *
   * **传 projectId 只改那个项目**，其他项目不受影响；不传改全局默认。
   */
  setPermissionLevel(level: string, projectId?: string | null): Promise<{ ok: boolean }> {
    return this.request('/api/permissions', {
      method: 'POST',
      body: projectId ? { level, projectId } : { level },
    });
  }

  /** 关闭行为设置。 */
  closeSettings(): Promise<{ settings: { closeAction: 'tray' | 'quit' }; running: number }> {
    return this.request('/api/close-settings');
  }

  setCloseAction(closeAction: 'tray' | 'quit'): Promise<{ ok: boolean }> {
    return this.request('/api/close-settings', { method: 'POST', body: { closeAction } });
  }

  /** 关闭前检查：选「退出」且有 Agent 在跑时要提示。 */
  closeCheck(): Promise<{ action: 'tray' | 'quit'; running: number; confirm: boolean; message: string }> {
    return this.request('/api/close-check');
  }

  /** 任务模板。 */
  templates(): Promise<{ templates: TaskTemplateDto[] }> {
    return this.request('/api/templates');
  }

  /** 套用模板：只生成待确认草稿，**不派活**。 */
  applyTemplate(
    id: string,
    input: { label: string; goal: string },
  ): Promise<AppliedTemplateDto> {
    return this.request(`/api/templates/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: input,
    });
  }

  /** 更新状态。没查过时 check 为 null（不是错误）。 */
  update(): Promise<{ check: UpdateCheckDto | null; currentVersion: string | null }> {
    return this.request('/api/update');
  }

  /** IM 通道配置与状态。**不会回传 token 本身**。 */
  im(): Promise<ImStatusDto> {    return this.request('/api/im');
  }

  saveIm(botToken: string, projectId: string | null): Promise<{ ok: boolean; message?: string }> {
    return this.request('/api/im', { method: 'POST', body: { botToken, projectId } });
  }

  clearIm(): Promise<{ ok: boolean }> {
    return this.request('/api/im', { method: 'DELETE' });
  }

  startIm(): Promise<{ ok: boolean }> {
    return this.request('/api/im/start', { method: 'POST' });
  }

  /** 已生效的记忆（全局 + 项目）。 */
  memoryList(projectId: string): Promise<{    global: Array<{ id: string; kind: string; text: string; source: string }>;
    project: Array<{ id: string; kind: string; text: string; source: string }>;
  }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/memory-list`);
  }

  /** 删掉一条已生效的记忆。 */
  forgetMemory(
    projectId: string,
    scope: 'global' | 'project',
    entryId: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/memory/${scope}/${encodeURIComponent(entryId)}/forget`,
      { method: 'POST' },
    );
  }

  /** 待审批的危险动作。 */
  approvals(projectId?: string): Promise<{ approvals: ApprovalDto[] }> {    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request(`/api/approvals${query}`);
  }

  approve(approvalId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: 'POST',
      body: { reason: reason ?? '' },
    });
  }

  reject(approvalId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: 'POST',
      body: { reason: reason ?? '' },
    });
  }

  /** 设置用量止损上限。 */
  setGuard(
    projectId: string,
    guard: { perTask?: number; perDay?: number },
  ): Promise<{ ok: boolean; guard: unknown }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/guard`, {
      method: 'POST',
      body: guard,
    });
  }

  route(query: string): Promise<{
    decision: 'unique' | 'ambiguous' | 'none';
    candidates: Array<{ projectId: string; name: string; score: number; reasons: string[] }>;
    hint: string;
  }> {
    return this.request('/api/route', { method: 'POST', body: { query } });
  }

  handoff(projectId: string, userText: string): Promise<{ ok: boolean; project: string }> {
    return this.request('/api/handoff', { method: 'POST', body: { projectId, userText } });
  }
}

/**
 * SSE 订阅器。
 *
 * 只负责"把事件按序交出来 + 断线重连带 after"，业务合并逻辑在上层。
 * 用 fetch + ReadableStream 而不是 EventSource，因为我们要带 `after` 且
 * EventSource 无法自定义重连的 Last-Event-ID 之外的参数。
 */
export class EventStream {
  private controller: AbortController | null = null;
  private closed = false;
  private retryDelay = 1000;
  private lastSeq = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly handlers: {
      readonly onEvent: (item: OutboundEvent) => void;
      readonly onGap: (reason: string) => void;
      readonly onStatus: (connected: boolean, detail?: string) => void;
    },
  ) {}

  /** 记录当前进度，重连时从这之后继续。 */
  setLastSeq(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq;
  }

  start(): void {
    this.closed = false;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
        // 正常结束（服务端关闭）：稍等重连。
        this.handlers.onStatus(false, '连接已关闭，正在重连');
      } catch (error) {
        if (this.closed) return;
        this.handlers.onStatus(
          false,
          error instanceof Error ? `连接中断：${error.message}` : '连接中断',
        );
      }
      if (this.closed) return;
      await sleep(this.retryDelay);
      // 退避，上限 10 秒
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
    }
  }

  private async connectOnce(): Promise<void> {
    this.controller = new AbortController();
    const response = await fetch(
      `${this.baseUrl}/api/events?after=${this.lastSeq}`,
      {
        signal: this.controller.signal,
        // SSE 也走同一个鉴权：否则事件流会被 401 拒掉，
        // 表现为"界面能打开但一直没反应"，很难查。
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${readToken()}` },
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    this.handlers.onStatus(true);
    this.retryDelay = 1000;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔消息。
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.consume(raw);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  private consume(raw: string): void {
    let seq = 0;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // 注释（心跳 / connected）
      if (line.startsWith('id: ')) seq = Number(line.slice(4));
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) return;

    let parsed: OutboundEvent;
    try {
      parsed = JSON.parse(dataLines.join('\n')) as OutboundEvent;
    } catch {
      return;
    }

    if (parsed.event.type === 'gap') {
      this.handlers.onGap(parsed.event.reason);
      return;
    }
    if (Number.isFinite(seq) && seq > 0) this.lastSeq = seq;
    this.handlers.onEvent(parsed);
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
