/**
 * TextInput / Textarea / Field —— 输入控件。
 *
 * ## 现状与问题
 *
 * 全仓 `<input>` 有 31 处，**没有一处带 `className`**。
 * 它们看起来还不错，完全是因为 `styles.css` 里有一条裸 `input { }` 规则。
 * 这有两个后果：
 *
 * 1. 新界面写 `<input>` 也能"看着还行"，于是没人意识到还有 `.input--sm`
 *    这类约定——密集区域用默认尺寸，密度就是不对；
 * 2. 以后任何一个"标签 + 输入 + 说明"的组合都得手写三遍布局，
 *    三处的高度、间距、错误色各写各的。
 *
 * `Field` 负责布局（label / input / hint / error 的相对位置与间距），
 * `TextInput` / `Textarea` 负责控件本身。业务代码只写 `Field`。
 */
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

/** 输入框尺寸：与 `.input--sm` 对齐。 */
export type InputSize = 'sm' | 'md';

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
  readonly inputSize?: InputSize;
  /** 贴容器底、无边框的样式（搜索框、命令面板）。 */
  readonly bare?: boolean;
  /**
   * 附加上下文类（`trace-search` 这类场景样式）。
   *
   * 与 Button 同样取舍：`ui/` 已经统一了"基础契约从哪里来"，
   * 场景类还在老 CSS 里，这一轮不重写它们。
   * **不许**写 `input--*`——尺寸档位请用 `inputSize` / `bare`。
   */
  readonly className?: string;
}

const CONTRACT_CLASSES = new Set(['input', 'input--sm', 'input--bare']);

function inputClassName(inputSize: InputSize, bare?: boolean, extra?: string): string {
  if (extra) {
    const stripped = extra.split(/\s+/).filter((c) => c && !CONTRACT_CLASSES.has(c));
    if (stripped.length !== extra.split(/\s+/).filter(Boolean).length) {
      throw new Error(
        `TextInput: className 里不许写 input--* 类（收到 "${extra}"）。` +
          '尺寸请用 inputSize / bare 属性。',
      );
    }
  }
  const parts = ['input'];
  if (inputSize === 'sm') parts.push('input--sm');
  if (bare) parts.push('input--bare');
  if (extra) parts.push(extra);
  return parts.join(' ');
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(props, ref) {
    const { inputSize = 'md', bare, className, ...rest } = props;
    return <input ref={ref} {...rest} className={inputClassName(inputSize, bare, className)} />;
  },
);

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  readonly inputSize?: InputSize;
  readonly className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    const { inputSize = 'md', className, ...rest } = props;
    return (
      <textarea
        ref={ref}
        {...rest}
        className={inputClassName(inputSize, undefined, className)}
      />
    );
  },
);

/**
 * 一段文案里的强调部分：正文主题色的短语，不用加粗堆砌。
 */
export function InlineHint(props: { readonly children: ReactNode }): JSX.Element {
  return <span className="field-hint-inline">{props.children}</span>;
}

export interface FieldProps {
  /** 标签文字。省略则不渲染标签，但**仍建议给 `aria-label`**。 */
  readonly label?: string;
  /** 输入下方的说明。 */
  readonly hint?: string;
  /** 报错文字。给了就不再显示 hint——同一位置只能说一件事。 */
  readonly error?: string;
  readonly required?: boolean;
  /** 必须给：Field 自动生成 id 并连同 label / hint / error 一起接好。 */
  readonly children: (ids: FieldIds) => ReactNode;
}

export interface FieldIds {
  readonly id: string;
  /** hint 与 error 的 id，接到 input 的 `aria-describedby` 上。 */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

/**
 * 表单一行：标签 + 控件 + 说明/错误。
 *
 * 用 render function 而不是 `children` 直接传节点：
 * 控件的 `id` 要让 `<label for>` 指过去，`aria-describedby` 要指到说明上——
 * 这两根线如果让每个调用方自己接，迟早有地方漏接，读屏用户就读不到报错。
 * 这里由 Field 统一生成并交给你，**接不接还是你负责，但至少 id 不会冲突**。
 */
export function Field(props: FieldProps): JSX.Element {
  const auto = useId();
  const id = `field-${auto}`;
  const message = props.error ?? props.hint;
  const messageId = message ? `${id}-msg` : undefined;

  return (
    <div className={`field${props.error ? ' field--error' : ''}`}>
      {props.label && (
        <label className="field-label" htmlFor={id}>
          {props.label}
          {props.required && (
            <span className="field-required" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      {props.children({ id, describedBy: messageId, invalid: Boolean(props.error) })}
      {message && (
        <p className="field-msg" id={messageId} role={props.error ? 'alert' : undefined}>
          {message}
        </p>
      )}
    </div>
  );
}
