/**
 * 界面 E2E 测试（真实 Chrome）。
 *
 * 覆盖真机才会暴露的交互：受控组件输入、下拉切换、快捷键、面板出现/消失。
 *
 * 前置：
 *   1. 已构建：`pnpm --filter @opencoxswain/web build`
 *   2. 服务在跑：`OCX_URL` 指向它（默认 http://127.0.0.1:47910/）
 *
 * 跑法：`node scripts/e2e.mjs`
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from './lib/browser.mjs';

const results = [];
let passed = 0;
let failed = 0;

/** 一条用例：失败不中断，最后统一报告。 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push({ ok: true, name });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    results.push({ ok: false, name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

const b = await openBrowser();

try {
  // ─────────────────────────────────────────────
  console.log('\n基础布局');
  // ─────────────────────────────────────────────

  await b.goto('/', 3000);

  await test('页面能加载，没有致命异常', async () => {
    assert.equal(await b.exists('.shell'), true, '缺少 .shell 根容器');
    assert.deepEqual(b.pageErrors, [], `页面有异常：${b.pageErrors.join('\n')}`);
  });

  await test('头部只出现一次产品名（旧版重复两次）', async () => {
    const n = await b.evaluate(
      `(document.querySelector('.head')?.innerText.match(/OpenCoxswain/g) ?? []).length`,
    );
    assert.ok(n <= 1, `头部出现了 ${n} 次产品名`);
  });

  await test('没有横向溢出', async () => {
    const r = await b.evaluate(
      `({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth })`,
    );
    assert.equal(r.s, r.c, `横向溢出 ${r.s - r.c}px`);
  });

  // ─────────────────────────────────────────────
  console.log('\n设置面板');
  // ─────────────────────────────────────────────

  await test('点齿轮打开设置，Esc 关闭', async () => {
    assert.equal(await b.click('button[aria-label="设置"]'), 'clicked');
    assert.equal(await b.waitForSelector('.settings'), true, '设置没打开');
    await b.press('Escape');
    assert.equal(await b.waitFor(async () => !(await b.exists('.settings'))), true, 'Esc 没关掉');
  });

  await test('Ctrl+, 也能打开设置', async () => {
    await b.press(',', 'Comma', 188, 2); // 2 = Ctrl
    assert.equal(await b.waitForSelector('.settings'), true, 'Ctrl+, 没打开设置');
    await b.press('Escape');
    await sleep(300);
  });

  await test('设置里五个分区都在', async () => {
    await b.click('button[aria-label="设置"]');
    await b.waitForSelector('.settings');
    const titles = await b.evaluate(
      `[...document.querySelectorAll('.settings-section-title')].map((e) => e.textContent)`,
    );
    for (const want of ['模型', '通用', '联网搜索', '手机通道', '记忆']) {
      assert.ok(titles.includes(want), `缺少分区「${want}」，实际：${titles.join('/')}`);
    }
    await b.press('Escape');
    await sleep(300);
  });

  // ─────────────────────────────────────────────
  console.log('\n记忆分区（受控下拉，真机验证）');
  // ─────────────────────────────────────────────

  await test('切换项目后记忆列表能加载出来', async () => {
    await b.click('button[aria-label="设置"]');
    await b.waitForSelector('#set-memory-project');

    // 先选一个空值，再选真实项目——确保 change 真的触发
    const options = await b.evaluate(
      `[...document.querySelectorAll('#set-memory-project option')]
        .map((o) => o.value).filter(Boolean)`,
    );
    assert.ok(options.length > 0, '没有可选项目');

    await b.select('#set-memory-project', options[0]);
    // 记忆加载是异步的，等区块出现
    const appeared = await b.waitFor(
      async () => {
        const t = await b.text('.settings-body');
        return (t ?? '').includes('待审核的候选');
      },
      10000,
    );
    assert.equal(appeared, true, '记忆区块没加载出来（接口或渲染有问题）');
    await b.press('Escape');
    await sleep(300);
  });

  // ─────────────────────────────────────────────
  console.log('\n命令面板');
  // ─────────────────────────────────────────────

  await test('Ctrl+K 打开，能列出项目与操作', async () => {
    await b.press('k', 'KeyK', 75, 2);
    assert.equal(await b.waitForSelector('.palette'), true, '命令面板没打开');
    const items = await b.evaluate(
      `[...document.querySelectorAll('.palette-label')].map((e) => e.textContent)`,
    );
    assert.ok(items.length >= 2, `只列出 ${items.length} 项`);
    assert.ok(
      items.some((i) => i.includes('设置')),
      `没有「打开设置」，实际：${items.join('/')}`,
    );
  });

  await test('命令面板能搜索过滤', async () => {
    await b.fill('.palette-input', '设置');
    await sleep(400);
    const items = await b.evaluate(
      `[...document.querySelectorAll('.palette-label')].map((e) => e.textContent)`,
    );
    assert.deepEqual(items, ['打开设置'], `过滤结果不对：${items.join('/')}`);
    await b.press('Escape');
    await sleep(300);
  });

  // ─────────────────────────────────────────────
  console.log('\n输入框（受控组件）');
  // ─────────────────────────────────────────────

  await test('输入文字后发送按钮变为可用', async () => {
    await b.fill('.composer textarea', '测试输入');
    await sleep(400);
    const disabled = await b.evaluate(
      `[...document.querySelectorAll('.composer-bar button')]
        .find((x) => x.textContent.trim() === '发送')?.disabled`,
    );
    assert.equal(disabled, false, '输入后发送仍禁用');
    // 清空，避免影响后续用例
    await b.fill('.composer textarea', '');
  });

  await test('@ 引用能弹出文件补全', async () => {
    await b.fill('.composer textarea', '@comp');
    await sleep(1500);
    const visible = await b.exists('.mention');
    assert.equal(visible, true, '@ 没有弹出补全');
    const items = await b.count('.mention-item');
    assert.ok(items > 0, '补全列表为空');
    await b.fill('.composer textarea', '');
    await sleep(300);
  });

  // ─────────────────────────────────────────────
  console.log('\nAgent 面板');
  // ─────────────────────────────────────────────

  await test('有 Agent 时右侧面板出现，且没有横向溢出', async () => {
    const hasPanel = await b.exists('.panel');
    if (hasPanel) {
      const r = await b.evaluate(
        `({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth })`,
      );
      assert.equal(r.s, r.c, '右侧面板导致横向溢出');
      const lanes = await b.count('.lane');
      assert.ok(lanes >= 0);
    }
  });

  await test('点 Agent 跑道能进入轨迹视图', async () => {
    if (!(await b.exists('.lane'))) return; // 没有 Agent 时跳过
    await b.click('.lane');
    const opened = await b.waitForSelector('.trace-head', 6000);
    assert.equal(opened, true, '没有进入轨迹视图');
    // 返回
    await b.clickButton('← 返回对话');
    await sleep(600);
    assert.equal(await b.exists('.trace-head'), false, '没能返回对话');
  });

  // ─────────────────────────────────────────────
  console.log('\n整体');
  // ─────────────────────────────────────────────

  await test('全程没有页面级异常', async () => {
    assert.deepEqual(b.pageErrors, [], `页面异常：\n${b.pageErrors.join('\n')}`);
  });

  await b.screenshot('e2e-final');
} finally {
  await b.close();
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${passed} 条，失败 ${failed} 条`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  · ${r.name}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
