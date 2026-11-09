import { Inbox } from '../components/Inbox.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function InboxPanel(): JSX.Element {
  const workbench = useWorkbench();
  return (
    <Inbox
      root={workbench.root}
      children={workbench.children}
      approvals={workbench.snapshot.approvals}
      busy={workbench.busy}
      onRootAction={(action) => workbench.onTaskAction(action)}
      onTaskAction={workbench.onTaskActionFor}
      onApproval={workbench.onApproval}
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
