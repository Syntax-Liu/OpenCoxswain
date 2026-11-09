import { useState } from 'react';
import type { UiPlugin } from '../plugins/registry.js';

export function Inspector({ tabs }: { tabs: UiPlugin[] }): JSX.Element | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  if (tabs.length === 0) return null;
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active) return null;
  const Active = active.render;

  return (
    <section className="panel inspector">
      <header className="panel-header inspector-tabs">
        <nav>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={tab.id === active.id ? 'tab active' : 'tab'}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.title}
            </button>
          ))}
        </nav>
      </header>
      <div className="panel-body inspector-body">
        <Active />
      </div>
    </section>
  );
}
