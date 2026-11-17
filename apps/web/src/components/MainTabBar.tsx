/**
 * 主区标签栏（照 DSH）。
 *
 *   │ 第 240 轮改动 × │ OpenCoxswain 0.116.2 │
 *
 * 每开一轮改动就多一个标签，可以同时开着好几个来回切。
 * 「对话」标签常驻、不可关闭——总得有个落脚的地方。
 */
import { IconClose } from './icons.js';
import type { MainTab } from './mainTabs.js';
import { CHAT_TAB_ID } from './mainTabs.js';
import { IconButton, OptionItem } from '../ui/index.js';

export interface MainTabBarProps {
  readonly tabs: readonly MainTab[];
  readonly activeId: string;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
}

export function MainTabBar(props: MainTabBarProps): JSX.Element | null {
  // 只有一个对话标签时不显示标签栏——没有可切换的，
  // 多出一条横杠只是白占 30px 高度。
  if (props.tabs.length <= 1) return null;

  return (
    <div className="main-tabs" role="tablist">
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeId;
        const closable = tab.id !== CHAT_TAB_ID;
        return (
          <div key={tab.id} className={`main-tab${active ? ' active' : ''}`}>
            <OptionItem
              role="tab"
              selected={active}
              variant="main-tab-label"
              onClick={() => props.onActivate(tab.id)}
              title={tab.title}
            >
              {tab.title}
            </OptionItem>
            {closable && (
              <IconButton title="关闭" aria-label={`关闭 ${tab.title}`} onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }} label={"关闭"}><IconClose size={12} /></IconButton>
            )}
          </div>
        );
      })}
    </div>
  );
}
