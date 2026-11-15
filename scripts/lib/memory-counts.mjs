/**
 * 从页面里读出记忆分区的计数。
 *
 * 不在 Node 侧用正则解析整段文本——那边的转义层次很容易出错
 * （\\d 在不同上下文里含义不同，踩过一次）。这里直接在页面里找 label。
 */
export const MEMORY_COUNTS_SNIPPET = `(() => {
  const labels = [...document.querySelectorAll('.settings-label')];
  const parse = (prefix) => {
    const el = labels.find((x) => (x.textContent || '').startsWith(prefix));
    if (!el) return -1;
    const m = /[0-9]+/.exec(el.textContent || '');
    return m ? Number(m[0]) : -1;
  };
  return {
    candidates: parse('待审核的候选'),
    live: parse('已生效'),
  };
})()`;
