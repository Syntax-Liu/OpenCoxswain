import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { modelForRole } from '../llm/models.js';
import type { ModelConfig, ModelSettings, RoleBindings } from '../llm/models.js';

/**
 * 角色没绑定时要回退到默认模型。
 *
 * ## 为什么需要
 *
 * 界面里那行文案写的是「不绑定的角色会用『沿用当前密钥』那套默认配置」，
 * 但 `modelForRole` 原来直接 `return null`。
 *
 * 后果不是"用错模型"，而是**模型参数全丢**：
 *
 *   用户勾了「支持图片输入」 → models.json 里 supportsImages: true
 *   → 但 roles 全是 null → paramsOf() 拿到 null
 *   → supportsImages 一律按 false 处理
 *   → 图片确实发到了服务端，但请求体里没有 image 块
 *   → 模型说"我看不到图"
 *
 * 用户看到的是"发图没用"，实际是"勾了也没用"。
 */

function model(id: string, supportsImages?: boolean): ModelConfig {
  return {
    id,
    name: id,
    baseUrl: 'https://example.com/v1',
    apiKey: 'k',
    model: id,
    params: supportsImages === undefined ? {} : { supportsImages },
  };
}

function settings(models: ModelConfig[], roles: Partial<RoleBindings> = {}): ModelSettings {
  return {
    models,
    roles: { supervisor: null, assistant: null, agent: null, ...roles },
  };
}

describe('modelForRole 的绑定', () => {
  it('绑定了就用绑定的那个', () => {
    const s = settings([model('a'), model('b')], { assistant: 'b' });
    assert.equal(modelForRole(s, 'assistant')?.id, 'b');
  });

  it('绑定的 id 已不存在时回退（不返回 undefined）', () => {
    const s = settings([model('a')], { assistant: 'gone' });
    const got = modelForRole(s, 'assistant');
    // 只有一个模型 → 回退到它
    assert.equal(got?.id, 'a');
  });

  it('三个角色各管各的', () => {
    const s = settings([model('a'), model('b'), model('c')], {
      supervisor: 'a',
      assistant: 'b',
      agent: 'c',
    });
    assert.equal(modelForRole(s, 'supervisor')?.id, 'a');
    assert.equal(modelForRole(s, 'assistant')?.id, 'b');
    assert.equal(modelForRole(s, 'agent')?.id, 'c');
  });
});

describe('**没绑定时的回退**', () => {
  it('**只有一个模型 → 就是它**（最要紧的一条）', () => {
    const s = settings([model('only', true)]);
    const got = modelForRole(s, 'assistant');
    assert.equal(got?.id, 'only', '唯一的模型应该被当作默认');
    assert.equal(got?.params.supportsImages, true, 'supportsImages 要能传下去');
  });

  it('三个角色都能拿到那个唯一模型', () => {
    const s = settings([model('only')]);
    for (const role of ['supervisor', 'assistant', 'agent'] as const) {
      assert.equal(modelForRole(s, role)?.id, 'only', `${role} 没回退`);
    }
  });

  it('**有多个模型且没绑定 → 不猜**', () => {
    const s = settings([model('a'), model('b')]);
    assert.equal(
      modelForRole(s, 'assistant'),
      null,
      '多个模型时猜错比不生效更难查，应该返回 null',
    );
  });

  it('没有任何模型 → null', () => {
    assert.equal(modelForRole(settings([]), 'assistant'), null);
  });
});

/**
 * 保存模型设置后必须刷新 LLM 客户端。
 *
 * ## 为什么
 *
 * `LlmProvider` 在 `refresh()` 时创建一个 `OpenAiCompatClient`，
 * 而 `supportsImages` 是**创建时的快照**。
 *
 * 保存只写了 models.json —— 不调 refresh 的话，正在跑的那个 client
 * 还拿着旧值。用户勾了"支持图片输入"、点了保存、界面也显示已勾选，
 * 但**当前进程到重启前都不会发图片块**。
 *
 * 表现就是"发图没用"，而 models.json 看是对的，最难查。
 */
describe('**保存模型设置后要刷新客户端**', () => {
  it('POST /api/models 之后调了 refresh', () => {
    // 测试跑的是 dist/test/*.js，所以要读**源码**：
    //   dist/test/  →  ../../src/server/server.ts
    const src = readFileSync(new URL('../../src/server/server.ts', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/models'");
    assert.ok(start > 0, '找不到 /api/models 路由');
    const block = src.slice(start, start + 2500);

    assert.match(block, /saveModelSettings/, '路由里没有保存');
    assert.match(
      block,
      /llmSettings\??\.refresh\(\)/,
      '保存后没刷新 client —— supportsImages 会一直是旧值',
    );
  });
});
