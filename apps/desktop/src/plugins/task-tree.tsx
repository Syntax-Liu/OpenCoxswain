import { TaskTree } from '../components/TaskTree.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function TaskTreePanel(): JSX.Element {
  const workbench = useWorkbench();
  return (
    <TaskTree
      root={workbench.root}
      children={workbench.children}
      edges={workbench.edges}
      records={workbench.acceptance}
      evidence={workbench.evidence}
      stages={workbench.stages}
      busy={workbench.busy}
      onAction={workbench.onTaskAction}
      onAcceptance={workbench.onAcceptance}
    />
  );
}

export const taskTreePlugin: UiPlugin = {
  id: 'panel.task-tree',
  title: '任务树',
  slot: 'left',
  order: 10,
  render: TaskTreePanel,
};
