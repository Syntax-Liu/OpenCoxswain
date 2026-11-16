/**
 * 三个用户反复指出的问题，用测试锁死。
 *
 * ## 问题 1
 *
 * > 每次打开 Assistant 都是在最顶部的位置，需要用户手动下滑到最新内容
 *
 * 原因：`useAutoScroll` 只监听**消息条数**。切换会话时条数可能不变，
 * 就完全不会滚动。现在加 `identity`（项目 + 会话），变化时强制到底。
 *
 * ## 问题 2
 *
 * > 编辑重发复制等按钮…占位了，导致对话框总是有一行空白
 *
 * 原因：`.bubble-footer` 用 `opacity: 0` 隐藏，但仍在文档流里。
 * 改成 `position: absolute` 脱离文档流。
 *
 * ## 问题 3
 *
 * > 图标还是偏上视觉上无法与文字对齐
 *
 * 原因：**图标本身在 16×16 视口里画得不居中**。
 * `IconSupervisor` 的绘制中线在 y=6.38（视口中心是 8），
 * 所以盒子中线对齐了也没用——图看起来还是偏上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');
const scrollHook = readFileSync(new URL('../../src/components/useAutoScroll.ts', import.meta.url), 'utf8');
const conversation = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**问题1：打开会话必须在底部**', () => {
  it('useAutoScroll 接受会话身份参数', () => {
    assert.match(scrollHook, /identity\?: string/);
  });

  it('身份变化时强制滚到底', () => {
    assert.match(scrollHook, /\}, \[identity\]\)/);
  });

  it('Conversation 传了 identity', () => {
    // 现在还多传了流式内容长度（2026-11-16：输出时视图不跟随）
      assert.match(conversation, /useAutoScroll\(\s*visible\.length,\s*scrollIdentity,\s*props\.streaming/);
  });

  it('identity 能区分不同会话', () => {
    // 必须包含项目 id + 会话标识，否则不同会话的 identity 相同
    assert.match(conversation, /scrollIdentity = `\$\{props\.project\.id\}:\$\{props\.draftKey\}`/);
  });
});

describe('**问题2：消息操作按钮不能占位**', () => {
  // 最终方案（v0.93）：照 DSH 做成 26×26 的圆形图标按钮，**常显**。
  //
  // 中间走过两条弯路：
  //   1. 文字链 + opacity:0 —— 只隐藏视觉，高度还在，所以每条消息下面空一行
  //   2. 绝对定位 + 悬停浮现 —— 不占位了，但形态还是文字，不像 DSH

  it('按钮是 26×26 的方形图标按钮', () => {
    // 迁移到 .btn 契约后，尺寸由 md 档（26px）+ icon-md（方形宽度）共同决定。
    // 断言仍锁住「26×26 方形」这个意图，只是改成读契约本身。
    assert.match(rule('.btn--md'), /height:\s*var\(--h-md\)/);
    assert.match(rule('.btn--icon-md'), /width:\s*var\(--h-md\)/);
    // --h-md 必须真的是 26px
    assert.match(cleanCss, /--h-md:\s*26px/);
  });

  it('**常显，不靠 opacity:0 隐藏**', () => {
    // 用 opacity:0 隐藏是"占位"的根源——高度还在
    assert.doesNotMatch(rule('.bubble-footer'), /opacity:\s*0;/);
  });

  it('.message 是定位上下文（留给需要浮层的场景）', () => {
    assert.match(rule('.message'), /position:\s*relative/);
  });

  it('和内容之间只有很小的间距', () => {
    assert.match(rule('.bubble-footer'), /margin-top:\s*var\(--g-1\)/);
  });
});

describe('**问题3：图标在视口里必须居中**', () => {
  // 只查能用正则可靠解析的 circle / rect。
  // path 的精确验证见浏览器实测（16 个图标全部偏离 ≤0.25px）。
  function iconBody(name: string): string {
    const m = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`).exec(icons);
    return m?.[0] ?? '';
  }

  it('IconSupervisor 的图形留在 16 视口内（不被裁切）', () => {
    // 之前为了"居中"把底点挪到 15.5，结果描边超出视口被切掉一半。
    // 正确的要求是：**整个图形（含描边）都在 0~16 之内**。
    const body = iconBody('IconSupervisor');
    const shapes = [
      ...[...body.matchAll(/<circle\s+cx="[\d.]+"\s+cy="([\d.]+)"\s+r="([\d.]+)"/g)]
        .map((m) => ({ cy: Number(m[1]), r: Number(m[2]) })),
    ];
    assert.ok(shapes.length >= 4, '应该有中心 + 三个外围节点');
    const SW = 0.75; // stroke-width 1.5 的一半
    const minY = Math.min(...shapes.map((s) => s.cy - s.r)) - SW;
    const maxY = Math.max(...shapes.map((s) => s.cy + s.r)) + SW;
    assert.ok(minY >= 0, `图形顶部 ${minY.toFixed(2)} 超出视口，会被裁掉`);
    assert.ok(maxY <= 16, `图形底部 ${maxY.toFixed(2)} 超出视口，会被裁掉`);
  });

  it('IconMemory 的图形居中（曾经偏下 1.25px）', () => {
    const body = iconBody('IconMemory');
    // 两个气泡的 path 都是 M x y ... 起始 y 决定上沿
    const starts = [...body.matchAll(/<path\s+d="M([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
    assert.ok(starts.length >= 2, '应该有两个气泡');
    assert.ok(Math.min(...starts) <= 3, `上沿 y=${Math.min(...starts)} 太高，会偏下`);
  });

  it('所有图标都用统一视口', () => {
    assert.match(icons, /viewBox: '0 0 16 16'/);
  });
});

/**
 * **流式输出时视图要跟着往下走**（2026-11-16 反馈）。
 *
 * 用户：
 *
 * > 输出时不会自动翻到底部
 *
 * 根因：`useAutoScroll` 只监听**消息条数**。流式时条数不变，
 * 只有字符在增加——文字一直往下长，视图纹丝不动。
 */
describe('**流式时自动跟随**', () => {
  const hook = readFileSync(
    new URL('../../src/components/useAutoScroll.ts', import.meta.url),
    'utf8',
  );

  it('useAutoScroll 接受第三个参数（内容长度）', () => {
    assert.match(
      hook,
      /contentToken\?: number/,
      '没有内容长度参数 —— 流式时不会跟随',
    );
  });

  it('内容变化时滚到底', () => {
    const start = hook.indexOf('[contentToken]');
    assert.ok(start > 0, '没有监听 contentToken 的 effect');
    // 往前找这个 effect 的实现
    const block = hook.slice(Math.max(0, start - 500), start);
    assert.match(block, /scrollTop = el\.scrollHeight/, '内容变化时没滚到底');
  });

  it('**用户往上翻时不打扰**', () => {
    // 和消息条数的逻辑一致：不在底部就别拽回来。
    const start = hook.indexOf('[contentToken]');
    const block = hook.slice(Math.max(0, start - 500), start);
    assert.match(block, /atBottomRef\.current/, '没检查用户是否在底部');
  });

  it('Conversation 把 streaming 长度传进去了', () => {
    const conv = readFileSync(
      new URL('../../src/components/Conversation.tsx', import.meta.url),
      'utf8',
    );
    assert.match(conv, /props\.streaming\?\.length/, '没传流式内容长度');
  });
});

/**
 * **切项目必须清掉上一个项目的内容**（2026-11-16 用户反馈）。
 *
 * 用户截图：两个全新的空项目（test1 / advmath）显示的是
 * OpenCoxswain 项目里的同一段对话。
 *
 * 原因：
 *   1. `messages` 要等 `refreshProject` 的网络请求回来才替换，
 *      中间旧内容还挂在屏幕上
 *   2. `streaming`（流式缓冲）和 `thinking` **根本没人清过**
 */
describe('**切项目清空旧内容**', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

  it('openAssistant 清空 messages', () => {
    const start = app.indexOf('const openAssistant');
    assert.ok(start > 0, '找不到 openAssistant');
    const block = app.slice(start, start + 1200);
    assert.match(block, /messages: \[\]/, '切项目时没清 messages');
  });

  it('openAssistant 清空 streaming', () => {
    const start = app.indexOf('const openAssistant');
    const block = app.slice(start, start + 1200);
    assert.match(block, /streaming: ''/, '切项目时没清 streaming —— 会残留上一段半截的字');
  });

  it('openAssistant 清空 thinking', () => {
    const start = app.indexOf('const openAssistant');
    const block = app.slice(start, start + 1200);
    assert.match(block, /thinking: false/, '切项目时没清 thinking');
  });

  it('openExecutor 也清', () => {
    const start = app.indexOf('const openExecutor');
    assert.ok(start > 0);
    const block = app.slice(start, start + 1200);
    assert.match(block, /streaming: ''/, 'openExecutor 没清 streaming');
  });
});

/**
 * desktop-agent-ui 硬性门禁：输入法与输入框。
 *
 * ## 1. 中文输入法选词时按 Enter 不能发送
 *
 * 中文用户敲 `nihao` 看到候选框，按 Enter 是**选词**，不是发送。
 * 不挡的话：每选一次词就发一条消息，内容还是半截拼音。
 *
 * ## 2. 输入框高度要自适应
 *
 * 原来 `rows={2}` 固定两行：敲到第 5 行时前 3 行要靠内部滚翻上去，
 * 看不到刚打的字。
 */
describe('**输入法安全发送**', () => {
  const conv = readFileSync(
    new URL('../../src/components/Conversation.tsx', import.meta.url),
    'utf8',
  );

  it('监听 compositionstart/end', () => {
    assert.match(conv, /onCompositionStart/, '没有监听组词开始');
    assert.match(conv, /onCompositionEnd/, '没有监听组词结束');
  });

  it('**三重判断缺一不可**', () => {
    assert.match(conv, /isComposingRef\.current/, '缺 isComposing 状态');
    assert.match(conv, /isComposing/, '缺原生 isComposing');
    assert.match(conv, /keyCode === 229/, '缺 keyCode 229（老浏览器组词期）');
    assert.match(conv, /500/, '缺 500ms 守卫（部分输入法 compositionend 后才发 keydown）');
  });

  it('组词期间直接 return，不发送', () => {
    const start = conv.indexOf('const composing');
    const block = conv.slice(start, start + 600);
    assert.match(block, /if \(composing\) return/, '组词时没拦住');
  });
});

describe('**输入框高度自适应**', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

  it('用 field-sizing: content', () => {
    assert.match(css, /field-sizing:\s*content/, '没有自适应高度');
  });

  // **先把注释剥掉再匹配**：CSS 注释里也有花括号和 "height" 字样，
  // 不剥的话正则会在注释处截断，断言假失败。
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('高度要能 auto（不然 field-sizing 不生效）', () => {
    const m = /\.composer textarea\s*\{([^}]*)\}/.exec(cssNoComments);
    assert.ok(m, '找不到 .composer textarea');
    assert.match(m[1] ?? '', /height:\s*auto/, '缺 height: auto');
  });

  it('有上限且超限能滚', () => {
    const m = /\.composer textarea\s*\{([^}]*)\}/.exec(cssNoComments);
    const body = m?.[1] ?? '';
    assert.match(body, /max-height/, '没有上限');
    assert.match(body, /overflow-y:\s*auto/, '超限不能滚');
  });
});