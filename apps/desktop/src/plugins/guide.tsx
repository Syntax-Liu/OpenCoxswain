import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

const DRAFT = ['planning', 'awaiting_approval'];

/** 首次引导清单：接入仓库 → 生成任务单 → 确认开工，全部完成后自动隐藏。 */
function GuidePanel(): JSX.Element | null {
  const { root } = useWorkbench();
  if (root && !DRAFT.includes(root.status)) return null;

  const steps = [
    { label: '接入一个仓库', done: true, hint: '仓库已连上，写入只会落在它的工作目录内。' },
    {
      label: '让总管生成任务单',
      done: root !== null,
      hint: '在中间的输入框写一句目标，点「交给总管」。',
    },
    {
      label: '确认开工',
      done: false,
      hint: '看过执行清单、预算与写入范围后，点「确认开工」。',
    },
  ];

  return (
    <section className="panel guide">
      <header className="panel-header">
        <h2>第一次使用</h2>
        <span className="count">3 步</span>
      </header>
      <div className="panel-body">
        <ol className="guide-steps">
          {steps.map((step, index) => (
            <li key={step.label} data-done={step.done}>
              <span className="guide-index">{step.done ? '✓' : index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <p className="hint">{step.hint}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export const guidePlugin: UiPlugin = {
  id: 'panel.guide',
  title: '第一次使用',
  slot: 'left',
  order: 1,
  render: GuidePanel,
};
