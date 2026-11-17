import { useState } from 'react';

import type { ApiClient, TaskTemplateDto } from '../api.js';
import { Button, OptionItem, TextButton, TextInput, Textarea } from '../ui/index.js';

/** 内置模板的展示名与说明（与后端对应）。 */
const PRESET: Record<string, { icon: string; hint: string }> = {
  'fix-bug': { icon: '🐞', hint: '坏了的东西修好' },
  'small-feature': { icon: '✨', hint: '边界清楚的新功能' },
  docs: { icon: '📄', hint: '补文档、写说明' },
  refactor: { icon: '🧹', hint: '不改行为，只改结构' },
  research: { icon: '🔍', hint: '只读排查，不动文件' },
};

export interface TemplatePickerProps {
  readonly api: ApiClient;
  readonly onPick: (applied: {
    label: string;
    goal: string;
    writeScope: readonly string[];
    criteria: unknown;
    policy: string;
  }) => void;
}

/**
 * 任务模板选择器。
 *
 * 选了模板只是**把输入框预填好**，用户还要自己确认发送。
 * 界面上明确写着这一点——不能让人以为点一下就自动跑起来了。
 */
export function TemplatePicker(props: TemplatePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplateDto[]>([]);
  const [label, setLabel] = useState('');
  const [goal, setGoal] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    if (templates.length > 0) {
      setOpen(true);
      return;
    }
    try {
      const result = await props.api.templates();
      setTemplates(result.templates);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不到模板');
    }
  };

  const use = async (): Promise<void> => {
    if (!selected || !goal.trim()) return;
    try {
      const applied = await props.api.applyTemplate(selected, {
        label: label.trim() || '',
        goal: goal.trim(),
      });
      props.onPick({
        label: applied.label,
        goal: applied.goal,
        writeScope: applied.writeScope,
        criteria: applied.criteria,
        policy: applied.policy,
      });
      setOpen(false);
      setSelected(null);
      setLabel('');
      setGoal('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '套用失败');
    }
  };

  if (!open) {
    return (
      <Button onClick={() => void load()} variant="ghost" size="sm">用模板
      </Button>
    );
  }

  return (
    <div className="template-picker">
      <div className="template-head">
        <strong>选一个模板</strong>
        <span className="muted small">填好之后还要你自己点发送</span>
        <TextButton onClick={() => setOpen(false)}>收起
        </TextButton>
      </div>

      <div className="template-grid">
        {templates.map((t) => {
          const preset = PRESET[t.id] ?? { icon: '•', hint: t.whenToUse };
          return (
            <OptionItem
              key={t.id}
              variant="template-card"
              selected={selected === t.id}
              onClick={() => setSelected(t.id)}
            >
              <span className="template-icon">{preset.icon}</span>
              <span className="template-name">{t.name}</span>
              <span className="template-hint">{preset.hint}</span>
              {t.readonly && <span className="template-tag">只读</span>}
            </OptionItem>
          );
        })}
      </div>

      {selected && (
        <div className="template-form">
          <TextInput value={label}
            placeholder="标题（可留空，默认用模板名）"
            onChange={(e) => setLabel(e.target.value)} />
          <Textarea value={goal}
            placeholder="具体要做什么（模板已帮你写好结构，填 {} 处即可）"
            rows={4}
            onChange={(e) => setGoal(e.target.value)} />
          <Button onClick={() => void use()} size="sm">填入输入框
          </Button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
