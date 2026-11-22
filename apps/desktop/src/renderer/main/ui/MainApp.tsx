import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { App, AppState } from '../appStore';
import { DevicePicker, DevicesTab } from './DevicesTab';
import { FtpOutcomeDialog } from './FtpOutcomeDialog';
import { GroupTab } from './GroupTab';
import { ConnectionBanners, DeviceChips } from './Header';
import { HistoryTab } from './HistoryTab';
import { AppContext, useAppState } from './hooks';
import { Notices } from './Notices';
import { RideTab } from './RideTab';
import { SettingsTab } from './SettingsTab';
import { WorkoutsTab } from './WorkoutsTab';
import './main.css';

export type TabId = 'ride' | 'workouts' | 'devices' | 'group' | 'history' | 'settings';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'ride', label: 'Ride' },
  { id: 'workouts', label: 'Workouts' },
  { id: 'devices', label: 'Devices' },
  { id: 'group', label: 'Group' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

/** Ride, unless there is no trainer to ride with yet. */
export function defaultTab(state: AppState): TabId {
  if (state.simMode) return 'ride';
  const remembered = state.settings?.devices.trainer !== undefined;
  const connected = state.live?.devices.trainer?.state === 'connected';
  return remembered || connected ? 'ride' : 'devices';
}

function TabBar({ tab, onSelect }: { tab: TabId; onSelect: (tab: TabId) => void }) {
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    if (next) {
      onSelect(next.id);
      refs.current[next.id]?.focus();
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onKeyDown}>
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
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A freewheel: outer ring and hub. Drawn here, no external asset. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" />
    </svg>
  );
}

function SimBadge() {
  const simMode = useAppState((s) => s.simMode);
  if (!simMode) return null;
  return (
    <span className="badge badge-sim" data-testid="sim-badge">
      Simulation
    </span>
  );
}

function Shell({ app, initialTab }: { app: App; initialTab: TabId | undefined }) {
  const [tab, setTabState] = useState<TabId>(() => initialTab ?? defaultTab(app.store.getState()));
  // Opening Workouts from an "FTP test" link scrolls to the tests.
  const [ftpFocus, setFtpFocus] = useState(false);
  const setTab = (next: TabId): void => {
    setFtpFocus(false);
    setTabState(next);
  };
  const openFtpTests = (): void => {
    setTabState('workouts');
    setFtpFocus(true);
  };
  // Each tab starts at the top (the panel element is shared between tabs).
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    mainRef.current?.scrollTo?.(0, 0);
  }, [tab]);
  return (
    <div className="app">
      <div className="chrome">
        <header className="app-header">
          <div className="brand">
            <BrandMark />
            <span className="brand-name">Freilauf</span>
            <SimBadge />
          </div>
          <DeviceChips />
        </header>
        <nav className="app-nav" aria-label="Main">
          <TabBar tab={tab} onSelect={setTab} />
        </nav>
        <ConnectionBanners />
      </div>
      <main
        ref={mainRef}
        className="app-main"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        data-testid={`panel-${tab}`}
      >
        {tab === 'ride' && <RideTab onOpenWorkouts={() => setTab('workouts')} />}
        {tab === 'workouts' && (
          <WorkoutsTab
            onGoToRide={() => setTab('ride')}
            onOpenSettings={() => setTab('settings')}
            focusFtpTests={ftpFocus}
          />
        )}
        {tab === 'devices' && <DevicesTab />}
        {tab === 'group' && <GroupTab onOpenSettings={() => setTab('settings')} />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'settings' && <SettingsTab onOpenFtpTests={openFtpTests} />}
      </main>
      <DevicePicker />
      <FtpOutcomeDialog />
      <Notices />
    </div>
  );
}

function Gate({ app, initialTab }: { app: App; initialTab: TabId | undefined }) {
  const loaded = useAppState((s) => s.settings !== null && s.live !== null);
  if (!loaded) {
    return (
      <div className="app app-loading" data-testid="app-loading" role="status">
        <span className="spinner" aria-hidden="true" /> Starting…
        <Notices />
      </div>
    );
  }
  return <Shell app={app} initialTab={initialTab} />;
}

export interface MainAppProps {
  /** Must be a stable instance for the window's lifetime. */
  app: App;
  /** Tab shown first; defaults to Ride, or Devices when there is no trainer yet. */
  initialTab?: TabId;
}

/** Root of the main window. */
export function MainApp({ app, initialTab }: MainAppProps) {
  return (
    <AppContext value={app}>
      <Gate app={app} initialTab={initialTab} />
    </AppContext>
  );
}
