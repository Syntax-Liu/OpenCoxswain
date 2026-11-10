import type {
  AcceptanceDecision,
  Assistant,
  ChannelInput,
  ChannelTestResult,
  ChannelView,
  CostLedger,
  CreatePlanRequest,
  CreateProjectRequest,
  DeliveryMergeResult,
  DeliveryPlan,
  DiffReview,
  GateQuality,
  MemoryCandidate,
  MemoryEntry,
  MemoryMatch,
  MemoryReport,
  MemoryWriteResult,
  Project,
  RoleName,
  RouteSuggestion,
  Schedule,
  ScheduleRun,
  Task,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';

export const DAEMON_URL =
  ((import.meta.env.VITE_DAEMON_URL as string | undefined) ?? 'http://127.0.0.1:47821').replace(
    /\/$/,
    '',
  );

export type TaskAction = 'approve' | 'reject' | 'cancel' | 'pause' | 'resume' | 'retry';
export type WorkerAction = 'pause' | 'resume' | 'terminate';

/** 密钥状态：只报是否配置与来源，不回传明文。 */
export interface SecretsStatus {
  backend: string;
  llm: { configured: boolean; source: 'vault' | 'env' | 'none' | string };
}

/** 自动更新检查结果；未配置更新源时 configured 为 false，其余字段为空。 */
export interface UpdateStatus {
  configured: boolean;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  date: string | null;
  error: string | null;
}

export type RemoteNodeStatus = 'idle' | 'busy' | 'offline';

export type RemoteJobStatus =
  | 'queued'
  | 'assigned'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** 远程执行节点：由节点主动连入，daemon 不主动外连。 */
export interface RemoteNodeView {
  id: string;
  name: string;
  status: RemoteNodeStatus;
  capabilities: string[];
  registeredAt: number;
  lastSeenAt: number;
  currentJobId: string | null;
}

/** 远程任务：节点只执行，代码包回传后仍由本地复核。 */
export interface RemoteJobView {
  id: string;
  taskId: string;
  status: RemoteJobStatus;
  nodeId: string | null;
  branch: string;
  runtime: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  attempts: number;
  createdAt: number;
  assignedAt: number | null;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  exitCode: number | null;
  log: string;
  cost: CostLedger | null;
}

/** 远程执行总状态；接入令牌仅在开启后可见。 */
export interface RemoteStatus {
  enabled: boolean;
  enrollmentToken: string;
  heartbeatMs: number;
  nodes: RemoteNodeView[];
  jobs: RemoteJobView[];
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const tauriCore = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;

/**
 * 桌面壳能力（Tauri 命令）。浏览器里跑工作台时不可用，
 * 调用方要先看 available，避免把「没有桌面壳」当成更新失败。
 */
export const desktop = {
  get available(): boolean {
    return Boolean(tauriCore);
  },

  version(): Promise<string> {
    if (!tauriCore) return Promise.reject(new Error('只有桌面端才能读取版本'));
    return tauriCore.invoke<string>('app_version');
  },

  updateCheck(): Promise<UpdateStatus> {
    if (!tauriCore) return Promise.reject(new Error('只有桌面端才能检查更新'));
    return tauriCore.invoke<UpdateStatus>('update_check');
  },

  updateInstall(): Promise<string> {
    if (!tauriCore) return Promise.reject(new Error('只有桌面端才能安装更新'));
    return tauriCore.invoke<string>('update_install');
  },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${DAEMON_URL}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // 非 JSON 错误体直接使用原文
    }
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  snapshot(projectId?: string): Promise<WorkbenchSnapshot> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return request<WorkbenchSnapshot>(`/api/bootstrap${query}`);
  },

  gateQuality(projectId?: string): Promise<GateQuality> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return request<GateQuality>(`/api/gate-quality${query}`);
  },

  memory(
    projectId: string,
  ): Promise<{ report: MemoryReport; entries: MemoryEntry[] }> {
    return request(`/api/memory?projectId=${encodeURIComponent(projectId)}`);
  },

  memorySearch(projectId: string, q: string): Promise<{ matches: MemoryMatch[] }> {
    return request(
      `/api/memory?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`,
    );
  },

  /** 跨项目检索记忆（含全局），结果自带 projectId。 */
  memorySearchAll(q: string): Promise<{ matches: MemoryMatch[] }> {
    return request(`/api/memory?scope=all&q=${encodeURIComponent(q)}`);
  },

  /** 全局路由：只返回候选项目与依据，不建单。 */
  routeGoal(goal: string): Promise<{ suggestions: RouteSuggestion[] }> {
    return request('/api/route', { method: 'POST', body: JSON.stringify({ goal }) });
  },

  secrets(): Promise<SecretsStatus> {
    return request<SecretsStatus>('/api/secrets');
  },

  setLlmKey(apiKey: string): Promise<SecretsStatus> {
    return request<SecretsStatus>('/api/secrets/llm', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    });
  },

  clearLlmKey(): Promise<SecretsStatus> {
    return request<SecretsStatus>('/api/secrets/llm', { method: 'DELETE' });
  },

  rememberMemory(body: MemoryCandidate): Promise<MemoryWriteResult> {
    return request('/api/memory', { method: 'POST', body: JSON.stringify(body) });
  },

  removeMemory(id: string): Promise<{ ok: boolean }> {
    return request(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  createProject(body: CreateProjectRequest): Promise<Project> {
    return request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) });
  },

  createPlan(
    projectId: string,
    goal: string,
    acceptanceCommand?: string,
    templateId?: string,
  ): Promise<{ root: Task; children: Task[] }> {
    const body: CreatePlanRequest = { goal };
    if (acceptanceCommand) body.acceptanceCommand = acceptanceCommand;
    if (templateId) body.templateId = templateId;
    return request(`/api/projects/${projectId}/plan`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  taskAction(taskId: string, action: TaskAction, note?: string): Promise<Task> {
    const body = action === 'reject' ? JSON.stringify({ note }) : undefined;
    return request<Task>(`/api/tasks/${taskId}/${action}`, { method: 'POST', body });
  },

  decideAcceptance(taskId: string, decisions: AcceptanceDecision[]): Promise<Task> {
    return request<Task>(`/api/tasks/${taskId}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({ decisions }),
    });
  },

  /** 记录人首次打开验收单的时间，用于反馈延迟统计。 */
  markViewed(taskId: string): Promise<Task> {
    return request<Task>(`/api/tasks/${taskId}/viewed`, { method: 'POST' });
  },

  delivery(taskId: string): Promise<DeliveryPlan> {
    return request<DeliveryPlan>(`/api/tasks/${taskId}/delivery`);
  },

  diffReview(taskId: string): Promise<DiffReview> {
    return request<DiffReview>(`/api/tasks/${taskId}/diff-review`);
  },

  mergeDelivery(
    taskId: string,
    planHash: string,
  ): Promise<{ plan: DeliveryPlan; result: DeliveryMergeResult }> {
    return request<{ plan: DeliveryPlan; result: DeliveryMergeResult }>(
      `/api/tasks/${taskId}/merge`,
      {
        method: 'POST',
        body: JSON.stringify({ confirm: true, planHash }),
      },
    );
  },

  reassignTask(taskId: string, role: RoleName, note?: string): Promise<Task> {
    return request<Task>(`/api/tasks/${taskId}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ role, note }),
    });
  },

  decideApproval(
    approvalId: string,
    status: 'approved' | 'rejected',
  ): Promise<unknown> {
    return request(`/api/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  sendInput(taskId: string, text: string): Promise<unknown> {
    return request(`/api/tasks/${taskId}/inputs`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  workerAction(workerId: string, action: WorkerAction): Promise<unknown> {
    return request(`/api/workers/${workerId}/${action}`, { method: 'POST' });
  },

  async artifact(id: string): Promise<string> {
    const response = await fetch(`${DAEMON_URL}/api/artifacts/${id}`);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `读取产物失败（${response.status}）`);
    return text;
  },

  updateProjectSettings(
    projectId: string,
    patch: { dailyBudgetUsd: number; maxConcurrency: number },
  ): Promise<Project> {
    return request<Project>(`/api/projects/${projectId}/settings`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  updateAssistant(
    patch: Pick<Assistant, 'name' | 'tone' | 'proactivity'>,
  ): Promise<Assistant> {
    return request<Assistant>('/api/assistant', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
  },

  schedules(projectId: string): Promise<{ schedules: Schedule[] }> {
    return request(`/api/schedules?projectId=${encodeURIComponent(projectId)}`);
  },

  createSchedule(body: {
    projectId: string;
    title: string;
    goal: string;
    templateId?: string | null;
    intervalMinutes: number;
  }): Promise<Schedule> {
    return request<Schedule>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  setScheduleEnabled(id: string, enabled: boolean): Promise<Schedule> {
    return request<Schedule>(`/api/schedules/${encodeURIComponent(id)}/enabled`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  runSchedule(id: string): Promise<ScheduleRun> {
    return request<ScheduleRun>(`/api/schedules/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    });
  },

  removeSchedule(id: string): Promise<{ ok: boolean }> {
    return request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  channels(): Promise<{ channels: ChannelView[] }> {
    return request<{ channels: ChannelView[] }>('/api/channels');
  },

  createChannel(body: ChannelInput): Promise<ChannelView> {
    return request<ChannelView>('/api/channels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateChannel(id: string, body: ChannelInput): Promise<ChannelView> {
    return request<ChannelView>(`/api/channels/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  testChannel(id: string): Promise<ChannelTestResult> {
    return request<ChannelTestResult>(`/api/channels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    });
  },

  removeChannel(id: string): Promise<{ ok: boolean }> {
    return request(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  remote(): Promise<RemoteStatus> {
    return request<RemoteStatus>('/api/remote');
  },

  remoteEnable(): Promise<RemoteStatus> {
    return request<RemoteStatus>('/api/remote/enable', { method: 'POST' });
  },

  remoteDisable(): Promise<RemoteStatus> {
    return request<RemoteStatus>('/api/remote/disable', { method: 'POST' });
  },

  remoteRemoveNode(id: string): Promise<{ ok: boolean }> {
    return request(`/api/remote/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

/** 订阅 daemon 事件流；返回取消函数。 */
export function subscribeEvents(onEvent: () => void): () => void {
  const source = new EventSource(`${DAEMON_URL}/api/events`);
  source.onmessage = () => onEvent();
  return () => source.close();
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
