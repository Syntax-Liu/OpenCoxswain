/**
 * MCP 客户端测试。
 *
 * 用**真实的子进程**跑一个最小的 MCP 服务器（不是 mock）——
 * 这样验证的是真实协议交互：握手、换行分隔的 JSON-RPC、超时。
 *
 * mock 掉子进程的话，「我们的 JSON 格式对不对」这件事根本没验证到。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_TIMEOUT_MS,
  McpConnection,
  McpManager,
  MCP_PROTOCOL_VERSION,
  parseServerConfigs,
} from '../mcp/client.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-mcp-'));
  temps.push(d);
  return d;
}

/**
 * 写一个最小的 MCP 服务器。
 *
 * 行为：
 * - 响应 initialize（回自己的协议版本）
 * - 响应 tools/list（两个工具）
 * - 响应 tools/call（回显参数）
 * - `hang` 工具永不回复（用来测超时）
 */
async function writeServer(dir: string, name = 'server.js'): Promise<string> {
  const code = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
    nl = buffer.indexOf('\\n');
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

function handle(line) {
  const msg = JSON.parse(line);

  // 通知不回
  if (msg.id === undefined) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '0.0.1' }
      }
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: '回显输入的文本',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'add', description: '两数相加',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
          { name: 'hang', description: '永不回复（测超时）',
            inputSchema: { type: 'object', properties: {} } }
        ]
      }
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};

    if (name === 'hang') return; // 故意不回

    if (name === 'echo') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'echo: ' + (args.text || '') }] }
      });
      return;
    }

    if (name === 'add') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: String((args.a || 0) + (args.b || 0)) }] }
      });
      return;
    }

    send({ jsonrpc: '2.0', id: msg.id, error: { message: '未知工具 ' + name } });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { message: '未知方法 ' + msg.method } });
}
`;
  const file = path.join(dir, name);
  await writeFile(file, code, 'utf8');
  return file;
}

/** 会立刻崩溃的服务器（测失败不影响其它）。 */
async function writeBrokenServer(dir: string): Promise<string> {
  const file = path.join(dir, 'broken.js');
  await writeFile(file, 'process.exit(1);', 'utf8');
  return file;
}

describe('连接与握手', () => {
  it('**连上真实的 MCP 服务器**', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [server],
    });

    try {
      const ok = await conn.connect();
      assert.equal(ok, true, '握手应当成功');
      assert.equal(conn.version, MCP_PROTOCOL_VERSION, '应当记录服务器协议版本');
    } finally {
      conn.close();
    }
  });

  it('**服务器起不来时返回 false 而不是抛错**', async () => {
    const conn = new McpConnection({
      name: 'nope',
      command: 'this-command-does-not-exist-xyz',
    });
    const ok = await conn.connect();
    assert.equal(ok, false);
    conn.close();
  });

  it('**服务器立刻崩溃时也不抛错**', async () => {
    const dir = await tmp();
    const broken = await writeBrokenServer(dir);
    const conn = new McpConnection({ name: 'broken', command: process.execPath, args: [broken] });
    const ok = await conn.connect();
    assert.equal(ok, false);
    conn.close();
  });
});

describe('工具列表', () => {
  it('**工具名加了服务器前缀**（多服务器同名不撞车）', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({ name: 'fake', command: process.execPath, args: [server] });

    try {
      await conn.connect();
      const tools = await conn.listTools();
      assert.equal(tools.length, 3);
      assert.ok(tools.every((t) => t.name.startsWith('fake__')), '都该带前缀');
      assert.ok(tools.some((t) => t.name === 'fake__echo'));
      assert.equal(tools.find((t) => t.name === 'fake__echo')?.remoteName, 'echo');
    } finally {
      conn.close();
    }
  });

  it('保留了 inputSchema 和 description', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({ name: 's', command: process.execPath, args: [server] });

    try {
      await conn.connect();
      const tools = await conn.listTools();
      const echo = tools.find((t) => t.remoteName === 'echo');
      assert.equal(echo?.description, '回显输入的文本');
      assert.ok(echo?.inputSchema && typeof echo.inputSchema === 'object');
    } finally {
      conn.close();
    }
  });
});

describe('调用工具', () => {
  it('**真实调用并拿到结果**', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({ name: 's', command: process.execPath, args: [server] });

    try {
      await conn.connect();
      const r = await conn.callTool('echo', { text: '你好' });
      assert.equal(r.ok, true);
      assert.equal(r.content, 'echo: 你好');
    } finally {
      conn.close();
    }
  });

  it('参数正确传给服务器', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({ name: 's', command: process.execPath, args: [server] });

    try {
      await conn.connect();
      const r = await conn.callTool('add', { a: 2, b: 3 });
      assert.equal(r.content, '5');
    } finally {
      conn.close();
    }
  });

  it('**超时真的生效**（服务器不回时不能挂死）', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const conn = new McpConnection({ name: 's', command: process.execPath, args: [server] }, 800);

    try {
      await conn.connect();
      const started = Date.now();
      const r = await conn.callTool('hang', {});
      const elapsed = Date.now() - started;

      assert.equal(r.ok, false);
      assert.match(r.content, /超时/);
      assert.ok(elapsed < 5000, `不该等太久，实际 ${elapsed}ms`);
    } finally {
      conn.close();
    }
  });
});

describe('多服务器管理', () => {
  it('**一个服务器坏了不影响另一个**', async () => {
    const dir = await tmp();
    const good = await writeServer(dir);
    const broken = await writeBrokenServer(dir);

    const manager = new McpManager([
      { name: 'good', command: process.execPath, args: [good] },
      { name: 'broken', command: process.execPath, args: [broken] },
    ]);

    try {
      await manager.start();
      assert.deepEqual(manager.connectedServers(), ['good'], '只有好的那个连上了');
      assert.ok(manager.listTools().length === 3);
    } finally {
      manager.close();
    }
  });

  it('调用不存在的工具给出明确错误', async () => {
    const manager = new McpManager([]);
    await manager.start();
    const r = await manager.call('nope__nope', {});
    assert.equal(r.ok, false);
    assert.match(r.content, /没有名为/);
    manager.close();
  });

  it('禁用的服务器不会被启动', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const manager = new McpManager([
      { name: 'off', command: process.execPath, args: [server], enabled: false },
    ]);
    await manager.start();
    assert.deepEqual(manager.connectedServers(), []);
    manager.close();
  });

  it('close 之后连接清空', async () => {
    const dir = await tmp();
    const server = await writeServer(dir);
    const manager = new McpManager([{ name: 's', command: process.execPath, args: [server] }]);
    await manager.start();
    manager.close();
    assert.deepEqual(manager.connectedServers(), []);
    assert.equal(manager.listTools().length, 0);
  });
});

describe('配置解析', () => {
  it('解析正常配置', () => {
    const configs = parseServerConfigs({
      servers: [{ name: 'db', command: 'node', args: ['srv.js'], cwd: '/tmp' }],
    });
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.name, 'db');
    assert.deepEqual(configs[0]?.args, ['srv.js']);
  });

  it('**缺 name 或 command 的条目被跳过**', () => {
    const configs = parseServerConfigs({
      servers: [
        { name: 'ok', command: 'node' },
        { name: 'no-command' },
        { command: 'no-name' },
        {},
      ],
    });
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.name, 'ok');
  });

  it('名字里的非法字符被替换（要当工具前缀用）', () => {
    const configs = parseServerConfigs({ servers: [{ name: 'my server!', command: 'node' }] });
    assert.equal(configs[0]?.name, 'my-server-');
  });

  it('坏输入返回空数组', () => {
    assert.deepEqual(parseServerConfigs(null), []);
    assert.deepEqual(parseServerConfigs({}), []);
    assert.deepEqual(parseServerConfigs({ servers: 'not-array' }), []);
  });

  it('默认超时是合理的值', () => {
    assert.ok(DEFAULT_TIMEOUT_MS >= 10_000 && DEFAULT_TIMEOUT_MS <= 120_000);
  });
});
