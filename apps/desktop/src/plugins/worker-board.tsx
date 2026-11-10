import { WorkerBoard } from '../components/WorkerBoard.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function WorkerBoardPanel(): JSX.Element {
  const workbench = useWorkbench();
  return (
    <WorkerBoard
      workers={workbench.workers}
      tasks={workbench.tasks}
      employees={workbench.snapshot.employees}
      busy={workbench.busy}
      onAction={workbench.onWorkerAction}
    />
  );
}

export const workerBoardPlugin: UiPlugin = {
  id: 'context.workers',
  title: '员工',
  slot: 'context',
  order: 10,
  render: WorkerBoardPanel,
};
