/**
 * 契约测试：C 的五个工具与 B 的三个工具，必须能被**上游真实** `defineTool`
 * 编译接受。我们的 schema DSL 写法不能只是"在我们自己眼里合法"。
 *
 * 上游包不可用时跳过（例如没有安装 dsh 依赖的机器），但本地必须跑过。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAssistantTools } from '../assistant/tools.js';
import { buildGlobalTools } from '../global/tools.js';
import { Gate } from '../executor/gate.js';
import { openBaoStore } from '../store.js';
import { makeMemoryFacility } from './helpers.js';

async function loadDefineTool(): Promise<((def: unknown) => unknown) | undefined> {
  // 1) 正常安装路径
  try {
    const mod = (await import('@deepseek-ai/dsh-tools' as string)) as {
      defineTool?: (def: unknown) => unknown;
    };
    if (mod.defineTool) return mod.defineTool;
  } catch {
    // 落到下面的直接文件导入
  }

  // 2) 本仓库 pnpm 布局下的实际位置。
  //    契约校验很关键，这里不靠"碰运气跳过"——找不到才算真缺失。
  try {
    const { existsSync } = await import('node:fs');
    const { readdirSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const pnpmDir = join(dir, 'node_modules', '.pnpm');
      if (existsSync(pnpmDir)) {
        const packages = readdirSync(pnpmDir).filter((n) => n.startsWith('@deepseek-ai+dsh-tools@'));
        for (const pkg of packages) {
          const entry = join(pnpmDir, pkg, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
          if (!existsSync(entry)) continue;
          const mod = (await import(pathToFileURL(entry).href)) as {
            defineTool?: (def: unknown) => unknown;
          };
          if (mod.defineTool) return mod.defineTool;
        }
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // 忽略
  }

  return undefined;
}

describe('工具定义契约', () => {
  it('C 与 B 的工具能被上游 defineTool 编译', async () => {
    const defineTool = await loadDefineTool();
    if (!defineTool) {
      // 上游不可用时不静默通过，但也不误报失败。
      console.info('[skip] @deepseek-ai/dsh-tools 不可用，跳过契约校验');
      return;
    }

    const store = await openBaoStore(makeMemoryFacility());
    const gate = new Gate(5);
    const noop = () => {};

    const tools = [
      ...buildAssistantTools({
        store,
        gate,
        runner: {} as never,
        log: noop,
        reportToUser: async () => {},
      }),
      ...buildGlobalTools({ store, log: noop, assistantOf: () => undefined }),
    ];

    assert.equal(tools.length, 8, 'C 五个 + B 三个');
    for (const tool of tools) {
      assert.doesNotThrow(() => defineTool(tool), `工具 ${tool.name} 应通过上游编译`);
    }
    await store.close();
  });
});
