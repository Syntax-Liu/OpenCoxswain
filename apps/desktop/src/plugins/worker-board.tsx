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
  id: 'panel.worker-board',
  title: '员工看板',
  slot: 'right',
  order: 10,
  render: WorkerBoardPanel,
};
