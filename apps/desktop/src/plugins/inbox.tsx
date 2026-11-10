import { Inbox } from '../components/Inbox.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function InboxPanel(): JSX.Element {
  const workbench = useWorkbench();
  return (
    <Inbox
      root={workbench.root}
      tasks={workbench.tasks}
      approvals={workbench.snapshot.approvals}
      latency={workbench.snapshot.review}
      busy={workbench.busy}
      onRootAction={(action) => workbench.onTaskAction(action)}
      onTaskAction={workbench.onTaskActionFor}
      onApproval={workbench.onApproval}
      onReview={workbench.onReview}
    />
  );
}

export const inboxPlugin: UiPlugin = {
  id: 'panel.inbox',
  title: '待决策',
  slot: 'left',
  order: 5,
  render: InboxPanel,
};
