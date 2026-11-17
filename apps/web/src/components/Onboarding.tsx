import { STARTER_EXAMPLES, markOnboardingSeen, type StarterExample } from './starterGuide.js';
import { ListItem, TextButton } from '../ui/index.js';

/**
 * 首次使用的引导面板。
 *
 * 出现在空对话里——用户填完密钥进来看见的第一个东西。
 *
 * ## 设计取舍
 *
 * 不写功能介绍，直接给三条**可以点的例子**。
 * 点了就有任务在跑，用户立刻明白它怎么工作——
 * 比任何一段文字说明都有效。
 */
export interface OnboardingProps {
  readonly onPick: (prompt: string) => void;
  readonly onDismiss: () => void;
}

export function Onboarding(props: OnboardingProps): JSX.Element {
  const pick = (example: StarterExample): void => {
    markOnboardingSeen();
    props.onPick(example.prompt);
  };

  return (
    <div className="onboarding">
      <div className="onboarding-head">
        <h3>试着让它干活</h3>
        <TextButton onClick={() => {
            markOnboardingSeen();
            props.onDismiss();
          }} className="onboarding-dismiss">知道了
        </TextButton>
      </div>

      <p className="onboarding-lead">
        你可以直接对它说话，它会派出 Agent 去做。下面三条可以点——
        每条都会真的开始干活。
      </p>

      <div className="onboarding-examples">
        {STARTER_EXAMPLES.map((example) => (
          <ListItem
            key={example.id}
            variant="onboarding-card"
            onClick={() => pick(example)}
          >
            <span className="onboarding-card-title">{example.title}</span>
            <span className="onboarding-card-hint">{example.hint}</span>
          </ListItem>
        ))}
      </div>

      <p className="onboarding-foot">
        也可以直接拖文件进来、打字时用 <kbd>@</kbd> 引用具体文件，
        按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 打开命令面板。
      </p>
    </div>
  );
}
