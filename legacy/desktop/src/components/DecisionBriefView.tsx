import type { DecisionBrief } from '@opencoxswain/shared';

const SECTIONS: Array<{ key: keyof DecisionBrief; label: string }> = [
  { key: 'changed', label: '改了什么' },
  { key: 'why', label: '为什么' },
  { key: 'verified', label: '验过什么' },
  { key: 'risks', label: '还有什么风险' },
];

/** 决策说明四段的唯一渲染入口：验收单与交付说明共用，避免两套叙述。 */
export function DecisionBriefView({ brief }: { brief: DecisionBrief | null }): JSX.Element {
  if (!brief) {
    return <p className="hint">系统还没有生成决策说明；提交验收前会再校验一次。</p>;
  }
  return (
    <>
      <dl>
        {SECTIONS.map((section) => (
          <div key={section.key}>
            <dt>{section.label}</dt>
            <dd>{String(brief[section.key] ?? '') || '—'}</dd>
          </div>
        ))}
      </dl>
      {brief.conflictReason ? (
        <p className="hint danger-text">冲突判定：{brief.conflictReason}</p>
      ) : null}
    </>
  );
}
