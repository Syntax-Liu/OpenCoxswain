/**
 * MCP 客户端（Model Context Protocol）。
 *
 * ## 为什么需要
 *
 * 没有 MCP 时，用户没法把**自己的**工具接进来——公司内部 API、数据库、
 * 自建服务。MCP 是这件事的事实标准（11 个 harness 里 8 个支持）。
 *
 * ## 实现范围（故意做窄）
 *
 * **只做 stdio 传输**。理由：
 * - stdio 是最通用的——本地工具全是这个
 * - HTTP 传输要处理流式、鉴权、会话，复杂度高出一个数量级
 * - 先能用，再谈覆盖全协议
 *
 * ## 协议要点（JSON-RPC 2.0 over 换行分隔的 JSON）
 *
 * ```
 * → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 * ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":...,"capabilities":...}}
 * → {"jsonrpc":"2.0","method":"notifications/initialized"}
 * → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 * ← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
 * → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":...,"arguments":{...}}}
 * ← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}
 * ```
 *
 * ## 三条硬约束
 *
 * 1. **超时必须生效**。MCP 服务器卡住不能把整个 Agent 拖死。
 * 2. **失败不能中断主流程**。服务器起不来 → 记日志、跳过，其它工具照常可用。
 * 3. **工具名要加前缀**。多个服务器可能都有 `search` 工具，不加前缀会撞车。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/** 我们声明支持的协议版本。服务器可以回它自己的，取交集即可。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 单次请求的超时。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 一个 MCP 服务器配置。 */
export interface McpServerConfig {
  /** 唯一名字，用作工具前缀。 */
  readonly name: string;
  /** 启动命令。 */
  readonly command: string;
  readonly args?: readonly string[];
  /** 额外的环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 工作目录。 */
  readonly cwd?: string;
  /** 是否启用。 */
  readonly enabled?: boolean;
}

/** MCP 工具（转换后）。 */
export interface McpTool {
  /** 加过前缀的名字：`<server>__<tool>`。 */
  readonly name: string;
  /** 原始工具名（发给服务器时用这个）。 */
  readonly remoteName: string;
  readonly server: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * 一个 MCP 服务器连接。
 *
 * 生命周期：`connect()` → `listTools()` → 多次 `callTool()` → `close()`。
 */
export class McpConnection {
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;
  /** 服务器自报的版本，记录用。 */
  private serverVersion = '';

  constructor(config: McpServerConfig, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  get name(): string {
    return this.config.name;
  }

  get version(): string {
    return this.serverVersion;
  }

  /** 启动子进程并完成握手。失败返回 false，不抛错。 */
  async connect(): Promise<boolean> {
    try {
      this.child = spawn(this.config.command, [...(this.config.args ?? [])], {
        cwd: this.config.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // **不启用 shell**。
        //
        // 早期为了在 Windows 上跑 .cmd/.bat 用了 shell: true，
        // 但 Node 明确警告：shell 模式下参数不会转义，直接拼进命令行——
        // 参数里带 `&` 或 `|` 就能注入别的命令（DEP0190）。
        //
        // MCP 服务器配置来自用户自己的文件，但仍然不该给一条注入路径。
        // 需要 .cmd/.bat 的用户自己写 `cmd /c xxx.cmd` 即可。
        shell: false,
      });

      this.child.on('error', () => this.failAll('MCP 服务器启动失败'));
      this.child.on('exit', () => this.failAll('MCP 服务器已退出'));
      this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
      this.child.stderr?.on('data', () => {
        // 服务器日志不进我们的输出，避免污染
      });

      // ---- 握手 ----
      await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'opencoxswain', version: '1.0.0' },
      });

      // 通知（无 id，不期待回复）
      this.notify('notifications/initialized');

      return true;
    } catch {
      this.close();
      return false;
    }
  }

  /** 列出工具。失败返回空数组。 */
  async listTools(): Promise<McpTool[]> {
    try {
      const result = (await this.request('tools/list', {})) as {
        tools?: Array<{
          name?: unknown;
          description?: unknown;
          inputSchema?: unknown;
        }>;
      };

      const tools = Array.isArray(result.tools) ? result.tools : [];
      const out: McpTool[] = [];

      for (const tool of tools) {
        const remoteName = typeof tool.name === 'string' ? tool.name : '';
        if (!remoteName) continue;
        out.push({
          // 加前缀：多个服务器可能都有同名工具
          name: `${this.config.name}__${remoteName}`,
          remoteName,
          server: this.config.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} },
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 调用一个工具。
   *
   * 返回文本化的结果——MCP 的 content 可能是 text / image / resource，
   * 我们只取文本部分（图片等其它类型在 Agent 的纯文本上下文里没有意义）。
   */
  async callTool(remoteName: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    try {
      const result = (await this.request('tools/call', {
        name: remoteName,
        arguments: args,
      })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };

      const parts: string[] = [];
      for (const block of result.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type) {
          parts.push(`（${block.type} 内容，此处不展开）`);
        }
      }

      const text = parts.join('\n').trim();
      return {
        ok: result.isError !== true,
        content: text || '（工具没有返回文本内容）',
      };
    } catch (error) {
      return {
        ok: false,
        content: `调用 MCP 工具失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 关闭连接。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll('连接已关闭');
    try {
      this.child?.kill();
    } catch {
      /* 已经退出了 */
    }
    this.child = null;
  }

  // ---- 内部 ----

  private notify(method: string): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    } catch {
      /* 写不进去就算了，通知本来就是可丢的 */
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error('MCP 连接未建立'));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      // **超时必须有**：MCP 服务器卡住不能把 Agent 拖死
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时（${method}，${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 按换行切分 JSON-RPC 消息。 */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');

    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return; // 非 JSON 的行（比如服务器日志）直接忽略
    }

    // 通知（无 id）：只记录协议版本，不做别的
    if (parsed.id === undefined) {
      return;
    }

    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;

    clearTimeout(waiting.timer);
    this.pending.delete(parsed.id);

    if (parsed.error) {
      waiting.reject(new Error(parsed.error.message ?? 'MCP 返回错误'));
      return;
    }

    // 从 initialize 的返回里记下服务器版本
    const result = parsed.result as { protocolVersion?: unknown } | undefined;
    if (result && typeof result.protocolVersion === 'string') {
      this.serverVersion = result.protocolVersion;
    }

    waiting.resolve(parsed.result);
  }

  private failAll(reason: string): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/**
 * 管理多个 MCP 服务器。
 *
 * **所有失败都被吞掉**：一个服务器起不来，不影响其它服务器，
 * 更不影响 Agent 的正常工作。
 */
export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private tools: McpTool[] = [];

  constructor(
    private readonly configs: readonly McpServerConfig[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** 连接所有启用的服务器并收集工具。 */
  async start(): Promise<void> {
    const enabled = this.configs.filter((c) => c.enabled !== false);

    await Promise.all(
      enabled.map(async (config) => {
        const conn = new McpConnection(config, this.timeoutMs);
        const ok = await conn.connect();
        if (!ok) {
          // 起不来就跳过，别的服务器照常
          conn.close();
          return;
        }
        this.connections.set(config.name, conn);
      }),
    );

    const collected: McpTool[] = [];
    for (const conn of this.connections.values()) {
      collected.push(...(await conn.listTools()));
    }
    this.tools = collected;
  }

  /** 所有可用工具。 */
  listTools(): readonly McpTool[] {
    return this.tools;
  }

  /** 按前缀名调用。 */
  async call(prefixedName: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const tool = this.tools.find((t) => t.name === prefixedName);
    if (!tool) {
      return { ok: false, content: `没有名为 ${prefixedName} 的 MCP 工具` };
    }
    const conn = this.connections.get(tool.server);
    if (!conn) {
      return { ok: false, content: `MCP 服务器 ${tool.server} 未连接` };
    }
    return conn.callTool(tool.remoteName, args);
  }

  /** 关闭所有连接。 */
  close(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.tools = [];
  }

  /** 当前连上的服务器名。 */
  connectedServers(): string[] {
    return [...this.connections.keys()];
  }
}

/** 从配置文件解析服务器列表（容错：坏条目跳过）。 */
export function parseServerConfigs(raw: unknown): McpServerConfig[] {
  const list = (raw as { servers?: unknown })?.servers;
  if (!Array.isArray(list)) return [];

  const out: McpServerConfig[] = [];
  for (const item of list) {
    const record = item as Partial<McpServerConfig>;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    if (typeof record.command !== 'string' || !record.command.trim()) continue;

    // 名字会当工具前缀，必须是安全的字符
    const name = record.name.trim().replace(/[^A-Za-z0-9_-]/g, '-');
    out.push({
      name,
      command: record.command.trim(),
      ...(Array.isArray(record.args) ? { args: record.args.map(String) } : {}),
      ...(record.env && typeof record.env === 'object'
        ? { env: record.env as Record<string, string> }
        : {}),
      ...(typeof record.cwd === 'string' ? { cwd: path.resolve(record.cwd) } : {}),
      enabled: record.enabled !== false,
    });
  }
  return out;
}
