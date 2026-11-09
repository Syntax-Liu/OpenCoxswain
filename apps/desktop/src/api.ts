import type {
  AcceptanceDecision,
  Assistant,
  CreatePlanRequest,
  CreateProjectRequest,
  MemoryCandidate,
  MemoryEntry,
  MemoryMatch,
  MemoryReport,
  MemoryWriteResult,
  Project,
  RoleName,
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
  ): Promise<{ root: Task; children: Task[] }> {
    const body: CreatePlanRequest = { goal };
    if (acceptanceCommand) body.acceptanceCommand = acceptanceCommand;
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
