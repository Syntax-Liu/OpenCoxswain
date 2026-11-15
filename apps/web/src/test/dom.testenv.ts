/**
 * 组件测试的 DOM 环境搭建。
 *
 * happy-dom 的类型与 DOM lib 的类型不完全兼容（两个不同的 HTMLElement 定义），
 * 这里集中做一次断言，业务代码与测试用例都不用关心。
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost/' });

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

g.window = win;
g.document = win.document;
// Node 20+ 的 navigator 是只读属性，只能用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: win.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = win.HTMLElement;
g.HTMLTextAreaElement = win.HTMLTextAreaElement;
g.HTMLInputElement = win.HTMLInputElement;
g.Node = win.Node;
g.Event = win.Event;
g.MouseEvent = win.MouseEvent;
g.getComputedStyle = win.getComputedStyle.bind(win);
g.IS_REACT_ACT_ENVIRONMENT = true;
/* eslint-enable @typescript-eslint/no-explicit-any */

export { win };

/** 建一个挂载点。 */
export function mountPoint(): any {
  const el = win.document.createElement('div');
  win.document.body.appendChild(el);
  return el;
}

/** 清空 body，避免用例之间互相污染。 */
export function resetBody(): void {
  win.document.body.innerHTML = '';
}
