/**
 * 控件层统一出口。
 *
 * ## 规则（新界面照着这个来）
 *
 * ```
 * 1. 要按钮        → Button          （3 个变体，别再造 .xxx-btn）
 * 2. 要图标按钮    → IconButton      （label 必填）
 * 3. 要删除按钮    → DangerButton    （名字本身就说明了后果）
 * 4. 要文字按钮    → TextButton
 * 5. 要输入框      → Field + TextInput / Textarea
 * 6. 要下拉        → Select
 * 7. 一行放不下的  → Text truncate
 * ```
 *
 * **`ui/` 之外的代码不允许出现裸 `<button>` / `<input>` / `<select>` / `<textarea>`。**
 * 这条由 `test/uiContract.test.ts` 守着，违反即测试失败。
 *
 * ## 为什么这些组件"长得像"旧的
 *
 * 因为内部渲染的就是原来那套 `.btn` / `.input` CSS 类。
 * 这一层换的是**写代码的人拿到什么**，不是**像素长什么样**。
 * 所以迁移是零视觉变更的，可以一批一批来。
 */
export {
  Button,
  DangerButton,
  TextButton,
  buttonClassName,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './Button.js';

export { IconButton, type IconButtonProps } from './IconButton.js';

export {
  Field,
  Textarea,
  TextInput,
  type FieldIds,
  type FieldProps,
  type InputSize,
  type TextareaProps,
  type TextInputProps,
} from './Field.js';

export { Text, type TextProps } from './Text.js';

export {
  ListItem,
  MenuItem,
  listItemClassName,
  type ListItemDensity,
  type ListItemProps,
  type MenuItemProps,
} from './ListItem.js';

export {
  OptionItem,
  SendButton,
  type OptionItemProps,
  type SendButtonProps,
} from './OptionItem.js';

export { WindowButton, type WindowButtonProps } from './WindowButton.js';

// Select 原本就写在 components/ 下，实现是对的（自绘浮层、键盘可用），
// 这里只把它挪到统一出口，业务代码的 import 路径统一走 ui/。
export { Select, type SelectOption, type SelectProps } from '../components/Select.js';
