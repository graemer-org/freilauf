import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { CommunityTab } from './CommunityTab';
import { HistoryTab } from './HistoryTab';

export type ActivityTab = 'history' | 'community';

const TABS: readonly { id: ActivityTab; label: string }[] = [
  { id: 'history', label: 'Rides' },
  { id: 'community', label: 'Community' },
];

/** Everything about rides already ridden: the history and the community (week, friends, …). */
export function ActivityScreen({
  tab,
  onTab,
  onOpenGroup,
  onOpenFtpTests,
}: {
  tab: ActivityTab;
  onTab: (tab: ActivityTab) => void;
  onOpenGroup: () => void;
  onOpenFtpTests: () => void;
}) {
  const refs = useRef<Partial<Record<ActivityTab, HTMLButtonElement | null>>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'history' ? 'community' : 'history';
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="activity">
      <div className="activity-tabs">
        <div className="tabs" role="tablist" aria-label="Activity" onKeyDown={onKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tab"
              data-testid={`tab-${t.id}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        data-testid={`panel-${tab}`}
      >
        {tab === 'history' ? (
          <HistoryTab />
        ) : (
          <CommunityTab onOpenGroup={onOpenGroup} onOpenFtpTests={onOpenFtpTests} />
        )}
      </div>
    </div>
  );
}
