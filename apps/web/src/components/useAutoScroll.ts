import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 自动滚动 + "有新消息"提示。
 *
 * 之前的行为是**每次消息变化都强制滚到底**，这在长对话里很讨厌：
 * 用户往上翻看历史时，一条新消息就把他拽回底部。
 *
 * 正确做法：
 * - 已经在底部附近 → 新消息自动跟随；
 * - 用户主动往上翻 → **不打扰**，只显示一个"回到底部"按钮，带未读计数。
 */

/** 距离底部多少像素以内算"在底部"。 */
const NEAR_BOTTOM_PX = 80;

export interface AutoScroll {
  readonly ref: React.RefObject<HTMLDivElement>;
  /** 是否贴底部（用于决定是否显示"回到底部"）。 */
  readonly atBottom: boolean;
  /** 不在底部期间来了多少条新消息。 */
  readonly unread: number;
  readonly scrollToBottom: () => void;
}

/**
 * @param dependency 消息条数。变化时决定是否跟随滚动。
 * @param identity   会话身份（项目 + 会话 id）。
 *   **变化时强制滚到底部**——用户切到一个会话，期望看到最新内容，
 *   而不是停在顶部。之前只监听条数，切换两个消息数相同的会话时
 *   就完全不会滚动（用户反馈"每次打开 Assistant 都在最顶部"）。
 * @param contentToken **流式内容长度**。
 *   流式输出时消息**条数不变**，只有字符在增加。只监听条数的话，
 *   文字一直往下长而视图不动，用户得自己往下扒拉（2026-11-16 反馈）。
 *   传 `streaming.length` 即可。
 */
export function useAutoScroll(
  dependency: number,
  identity?: string,
  contentToken?: number,
): AutoScroll {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const lastCount = useRef(dependency);
  // 与 atBottom 同步，供"内容变化"的 effect 读取而不产生依赖。
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(0);
  }, []);

  // 监听滚动，判断是否离开了底部。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = distance <= NEAR_BOTTOM_PX;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setUnread(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 内容变化时：在底部就跟随，否则累计未读。
  useEffect(() => {
    const delta = dependency - lastCount.current;
    lastCount.current = dependency;
    if (delta <= 0) return;

    // atBottom 用 ref 读取，避免把它放进依赖导致每次滚动都重跑。
    if (atBottomRef.current) {
      const el = ref.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
        // 首屏时消息可能还在异步布局（字体、Markdown 表格等），
        // 当场滚到底会落在中间。等两帧后再滚一次。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (atBottomRef.current && ref.current) {
              ref.current.scrollTop = ref.current.scrollHeight;
            }
          });
        });
      }
    } else {
      setUnread((n) => n + delta);
    }
  }, [dependency]);

  // **流式内容增长时跟随**（2026-11-16 反馈：输出时不会自动翻到底部）。
  //
  // 这一条和上面的 `dependency` 分开写，因为触发条件不同：
  //   - dependency 变化 = 多了一条消息
  //   - contentToken 变化 = 同一条消息变长了（流式）
  //
  // 流式时**每帧都可能变化**，所以只做最轻的事：直接设 scrollTop。
  // 不加未读计数——正在输出不算"未读"，用户就在看。
  useEffect(() => {
    if (contentToken === undefined) return;
    if (!atBottomRef.current) return;
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [contentToken]);

  // **会话切换：立刻到底。**
  //
  // 双重 rAF 是因为切过来时消息还没完成布局（字体、Markdown 表格、
  // 图片高度都要算），当场滚会落在中间。
  useEffect(() => {
    if (identity === undefined) return;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(0);
    const el = ref.current;
    if (!el) return;
    // 立刻滚一次（多数情况够用）
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      });
    });
    // 再补一次：字体/图片加载完之后高度会变
    const t = setTimeout(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, 120);
    return () => clearTimeout(t);
  }, [identity]);

  return { ref, atBottom, unread, scrollToBottom };
}
