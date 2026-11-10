import { useCallback, useEffect, useState } from 'react';
import type { Schedule } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';
import { formatDateTime } from '../ui.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function ScheduleTab(): JSX.Element {
  const { project, snapshot, events } = useWorkbench();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [templateId, setTemplateId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.schedules(project.id);
      setSchedules(result.schedules);
    } catch (error) {
      setNotice(errorText(error));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load, events.length]);

  async function act(operation: () => Promise<unknown>, message: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
      setNotice(message);
      await load();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function create(): void {
    const minutes = Math.trunc(intervalMinutes);
    if (minutes < 1) {
      setNotice('间隔至少 1 分钟');
      return;
    }
    void act(async () => {
      await api.createSchedule({
        projectId: project.id,
        title: title.trim(),
        goal: goal.trim(),
        templateId: templateId || null,
        intervalMinutes: minutes,
      });
      setTitle('');
      setGoal('');
    }, '已创建。到点只生成待审批任务单，不自动开工。');
  }

  return (
    <div className="schedule">
      <div className="settings-block">
        <h3>新建定时任务</h3>
        <div className="row">
          <input
            value={title}
            placeholder="标题，例如：每周依赖巡检"
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            value={goal}
            placeholder="目标：到点后要总管准备什么任务"
            onChange={(event) => setGoal(event.target.value)}
          />
        </div>
        <div className="row">
          <label className="muted">间隔（分钟）</label>
          <input
            type="number"
            min={1}
            max={43200}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))}
          />
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">不使用模板</option>
            {snapshot.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <button
            className="ghost"
            onClick={create}
            disabled={busy || title.trim() === '' || goal.trim() === ''}
          >
            创建
          </button>
        </div>
        <p className="muted">
          到点只生成一张待审批任务单，仍需你确认开工；项目里有未完成任务时整次跳过，错过时段不补跑。
        </p>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
      <ul className="schedule-list">
        {schedules.map((schedule) => (
          <li key={schedule.id} className={schedule.enabled ? '' : 'muted'}>
            <div className="schedule-main">
              <strong>{schedule.title}</strong>
              <span className="muted">
                每 {schedule.intervalMinutes} 分钟 · 下次 {formatDateTime(schedule.nextRunAt)}
                {schedule.lastRunAt ? ` · 上次 ${formatDateTime(schedule.lastRunAt)}` : ''}
              </span>
              <span>{schedule.goal}</span>
              {schedule.templateId ? (
                <span className="muted">模板：{schedule.templateId}</span>
              ) : null}
            </div>
            <div className="row">
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => api.setScheduleEnabled(schedule.id, !schedule.enabled),
                    schedule.enabled ? '已停用。' : '已启用，从当前时刻重新计时。',
                  )
                }
              >
                {schedule.enabled ? '停用' : '启用'}
              </button>
              <button
                className="ghost"
                disabled={busy || !schedule.enabled}
                onClick={() =>
                  void act(
                    () => api.runSchedule(schedule.id),
                    '已触发一次；若项目有未完成任务会跳过。',
                  )
                }
              >
                立即生成
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void act(() => api.removeSchedule(schedule.id), '已删除。')}
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {schedules.length === 0 ? (
          <li className="muted">还没有定时任务。适合放巡检、周报、依赖升级这类重复任务。</li>
        ) : null}
      </ul>
    </div>
  );
}

export const schedulePlugin: UiPlugin = {
  id: 'inspector.schedule',
  title: '定时',
  slot: 'bottom',
  order: 47,
  render: ScheduleTab,
};
