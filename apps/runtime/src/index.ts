/**
 * @opencoxswain/runtime —�?自研运行时�? *
 * 四层结构�? * ```
 * A 用户 ──┬─�?B Supervisor（路由，不执行）
 *          ├─�?C Assistant（一项目一常驻会话，主推入口）
 *          └─�?D 执行者（一事一 D，直接改代码，可追问�? * ```
 *
 * 这个包不依赖任何外部 Agent 框架，只依赖�? * - 一�?OpenAI 兼容�?LLM 端点（DeepSeek / OpenAI / 其他）；
 * - Node.js 内置能力�? *
 * 上层（daemon / 桌面壳）通过 `orchestrator` �?`runtime` 事件流驱�?UI�? */
export { Orchestrator, INTERNAL_NOTICE_PREFIX } from './orchestrator.js';
export type {
  OrchestratorOptions,
  RuntimeEvent,
  SpawnInput,
  SpawnResult,
} from './orchestrator.js';

export { AssistantSession, judgeConflict } from './assistant/session.js';
export { assistantSystemPrompt, assistantTools } from './assistant/prompt.js';

export {
  runExecutor,
  executorSystemPrompt,
  executorTools,
  createExecutorToolHost,
  classifyBlock,
} from './executor/executor.js';
export type { ExecutorOutcome, BlockKind } from './executor/executor.js';

export { Gate, scopesConflict, normalizeWriteScopes, parseScopeClaim } from './executor/gate.js';
export { Inbox } from './inbox/inbox.js';
export type { InboxItem, InboxTarget } from './inbox/inbox.js';

export { runLoop, chatOnce, truncate, errorText } from './session/loop.js';
export type { LoopEvent, ToolHost, RunLoopOptions } from './session/loop.js';

export { OpenAiCompatClient } from './llm/types.js';
export type {
  ChatMessage,
  LlmClient,
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmToolCall,
  ToolDefinition,
  AgentMessage,
} from './llm/types.js';

export {
  MemoryStore,
  newId,
  normalizePath,
  isExecutorTerminal,
  isInternalSource,
  INTERNAL_SOURCE_PREFIX,
} from './store/store.js';
export { SqliteStore } from './store/sqlite.js';
export type { SqliteStoreOptions } from './store/sqlite.js';
export type { RecoveryReport } from './orchestrator.js';
export type {
  Store,
  ProjectRow,
  SessionRow,
  ExecutorRow,
  ExecutorStatus,
  TurnRow,
  TurnJudgment,
  ReportRow,
  SessionKind,
} from './store/store.js';

export { findProject, handoff, projectBrief } from './global/assistant.js';
export type { RouteCandidate, RouteDecision, HandoffResult } from './global/assistant.js';

export { startServer } from './server/server.js';
export type { ServerOptions, RunningServer } from './server/server.js';
export { EventBus } from './server/bus.js';
export type { BusEvent, GapEvent, OutboundEvent } from './server/bus.js';

export { MarkdownMemoryStore, parseMarkdown, safeDirName } from './memory/store.js';
export type { MemoryStoreOptions, MemoryScope, WriteResult } from './memory/store.js';
export { checkCandidate, MEMORY_KINDS, normalizeText } from './memory/gate.js';
export type { MemoryEntry, MemoryKind, MemoryCandidate } from './memory/gate.js';
export { tokenize, rankEntries, scoreEntry } from './memory/search.js';
export type { MemoryMatch } from './memory/search.js';
