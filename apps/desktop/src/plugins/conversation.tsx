import { Conversation } from '../components/Conversation.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function ConversationPanel(): JSX.Element {
  const workbench = useWorkbench();
  return (
    <Conversation
      messages={workbench.snapshot.messages}
      root={workbench.root}
      children={workbench.children}
      templates={workbench.snapshot.templates}
      project={workbench.project}
      busy={workbench.busy}
      onPlan={workbench.onPlan}
      onAction={workbench.onTaskAction}
    />
  );
}

export const conversationPlugin: UiPlugin = {
  id: 'panel.conversation',
  title: '总管对话',
  slot: 'center',
  order: 10,
  render: ConversationPanel,
};
