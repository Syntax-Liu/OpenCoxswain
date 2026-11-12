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

export function useAutoScroll(dependency: number): AutoScroll {
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

  return { ref, atBottom, unread, scrollToBottom };
}
