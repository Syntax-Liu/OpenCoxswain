/**
 * 图标配色选择。
 *
 * 六种配色都是同一只猫耳机器人的换色（用户提供的 SVG）。
 * **紫罗兰是主图标**，也是默认值。
 *
 * ## 为什么改了立刻生效
 *
 * 图标本身就是界面的一部分，等保存再刷新会让人以为"没生效"。
 * 这里点了就写 localStorage 并通知上层重渲染。
 */
import { ICON_THEMES } from '../iconTheme.js';
import { AppIcon } from './AppIcon.js';
import { OptionItem } from '../ui/index.js';

export interface IconThemeSettingProps {
  readonly value: string;
  readonly onChange: (id: string) => void;
}

export function IconThemeSetting({ value, onChange }: IconThemeSettingProps): JSX.Element {
  return (
    <div className="icon-theme-setting">
      <p className="muted small">
        换一个配色，界面上所有出现图标的地方立刻跟着变。
        <strong>紫罗兰</strong>是主图标。
      </p>

      <div className="icon-theme-grid" role="radiogroup" aria-label="图标配色">
        {ICON_THEMES.map((theme) => {
          const active = theme.id === value;
          return (
            <OptionItem
              key={theme.id}
              role="radio"
              aria-checked={active}
              aria-label={theme.label}
              title={theme.label}
              variant="icon-theme-option"
              selected={active}
              extraClass={active ? 'is-active' : ''}
              onClick={() => onChange(theme.id)}
            >
              <AppIcon size={40} theme={theme.id} />
              <span className="icon-theme-label">{theme.label}</span>
            </OptionItem>
          );
        })}
      </div>
    </div>
  );
}
