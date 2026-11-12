# MCP 接入

> MCP（Model Context Protocol）让你把**自己的**工具接进 OpenCoxswain——
> 公司内部 API、数据库、自建服务。

---

## 为什么需要

没有 MCP 时，Agent 只能用内置的 5 个工具（读、写、编辑、列目录、执行命令）。
有了 MCP，你可以把任意能力暴露给它。

MCP 是这件事的事实标准——11 个主流 harness 里 8 个支持。

---

## 怎么用

### 1. 写配置

`~/.opencoxswain/mcp.json`：

```json
{
  "servers": [
    {
      "name": "demo",
      "command": "node",
      "args": ["C:\\path\\to\\your-server.mjs"]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 服务器名，会作为工具前缀 |
| `command` | ✅ | 启动命令 |
| `args` |  | 命令参数 |
| `env` |  | 额外环境变量 |
| `cwd` |  | 工作目录 |
| `enabled` |  | 设为 `false` 可临时停用 |

### 2. 重启应用

MCP 服务器在启动时连接。连不上只是少几个工具，**不影响其它功能**。

### 3. 用起来

服务器暴露的工具会自动出现在 Agent 的工具集里，名字带前缀：

```
demo__greet    ← 来自名为 demo 的服务器
```

**为什么要加前缀**：多个服务器可能都有叫 `search` 的工具，不加前缀会撞车。

---

## 一个能跑的最小服务器

```js
// server.mjs
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function handle(line) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;   // 通知不回

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'demo', version: '1.0.0' },
    }});
    return;
  }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'greet',
      description: '按名字打招呼',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    }]}});
    return;
  }

  if (msg.method === 'tools/call') {
    const a = msg.params.arguments || {};
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: '你好，' + (a.name || '陌生人') + '！' }],
    }});
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } });
}
```

---

## 实现范围（故意做窄）

| 项 | 支持 |
| --- | --- |
| **stdio 传输** | ✅ |
| HTTP / SSE 传输 | ❌ |
| tools（工具） | ✅ |
| resources / prompts | ❌ |
| 采样（sampling） | ❌ |

**为什么只做 stdio**：本地工具全是 stdio；HTTP 要处理鉴权、会话、流式，
复杂度高一个数量级。先把主流场景做扎实。

---

## 三条硬约束

### 1. 超时必须生效

单次请求默认 30 秒超时。**MCP 服务器卡住不能把整个 Agent 拖死**——
有测试专门用一个「永不回复」的工具验证这条。

### 2. 失败不能中断主流程

服务器起不来 / 中途崩溃 → 记日志、跳过。
其它服务器和内置工具照常可用。

### 3. 不启用 shell

Windows 上早期用了 `shell: true` 来跑 `.cmd`，但 Node 明确警告：
shell 模式下参数不转义、直接拼进命令行——参数里带 `&` 就能注入命令。

现在 `shell: false`。需要跑 `.cmd` 的，自己写 `cmd /c xxx.cmd`。

---

## 安全提示

**MCP 服务器是你在本机启动的任意程序，和主程序同权。**

它能看到你的文件、能联网。所以：
- 只接入你信任的服务器
- 不确定的服务器先用 `"enabled": false` 关着

这和扩展（extensions）是同一个信任前提：只放你信任的东西。
