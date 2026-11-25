/**
 * How a group ride plays (docs/rumble.md): chosen by whoever creates it — normal power-ups, or
 * Freilauf Rumble — and shown to everyone in the room. Riders whose app has no Freilauf Rumble
 * are named.
 */
import type { GroupRider } from '@freilauf/p2p';
import { useShallow } from 'zustand/react/shallow';
import type { GroupMode } from '../../../shared/powerUps';
import { GROUP_MODE_LABEL, RUMBLE_NAME } from '../../../shared/powerUps';
import { incompatibleNote, incompatibleRiders } from '../../core/rumble';
import type { AppState } from '../appStore';
import { useApp, useAppState } from './hooks';
import { PowerUpIcon } from './PowerUpIcon';
import { GroupPowerUps } from './PowerUpSettings';

/** One line on what each mode is. */
export const MODE_BLURB: Record<GroupMode, string> = {
  normal: 'Power-ups as usual: each rider helps only themselves.',
  rumble: `Grab items from feed bags and use them with the side buttons: throw a water bottle at the rider ahead, drop a mud puddle behind you, send hornets after the leader, pull on a rain cape. Only race positions move; recorded rides stay your own.`,
};

/** The mode that applies: the host's own choice, or the host's as received. */
export function groupModeOf(s: AppState): GroupMode {
  if (s.group.phase === 'joined' && s.group.role === 'host') return s.groupMode ?? 'normal';
  return s.live?.group?.mode ?? 'normal';
}

/** A small label: "Freilauf Rumble" (with its icon) or "Normal". */
export function ModeBadge({ mode }: { mode: GroupMode }) {
  return (
    <span className={`mode-badge is-${mode}`} data-testid="group-mode-badge" data-mode={mode}>
      <PowerUpIcon kind={mode === 'rumble' ? 'feedBag' : 'tailwind'} />
      {GROUP_MODE_LABEL[mode]}
    </span>
  );
}

function ModeSwitch({
  mode,
  onChange,
  testId,
}: {
  mode: GroupMode;
  onChange: (m: GroupMode) => void;
  testId: string;
}) {
  return (
    <div className="seg" role="group" aria-label="Mode of the group ride" data-testid={testId}>
      {(['normal', 'rumble'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="seg-item"
          aria-pressed={mode === m}
          data-testid={`${testId}-${m}`}
          onClick={() => onChange(m)}
        >
          {GROUP_MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

/** Before creating a ride: the mode it will have. */
export function ModeChoice() {
  const app = useApp();
  const mode = useAppState((s) => s.groupMode ?? 'normal');
  return (
    <div className="mode-choice" data-testid="group-mode-choice">
      <ModeSwitch mode={mode} onChange={(m) => app.setGroupMode(m)} testId="group-mode-create" />
      <span className="hint" data-testid="group-mode-blurb">
        {MODE_BLURB[mode]}
      </span>
    </div>
  );
}

/** Names of riders in the room whose app does not speak Freilauf Rumble (only in one). */
function useIncompatible(): string[] {
  return useAppState(
    useShallow((s) =>
      groupModeOf(s) === 'rumble'
        ? incompatibleRiders(s.live?.group?.riders ?? ([] as GroupRider[])).map((r) => r.name)
        : [],
    ),
  );
}

/**
 * In the room: the mode for everyone. The host can switch it (and, in a normal ride, power-ups
 * off); guests see the host's choice. Old apps are named.
 */
export function GroupModeRow({ role }: { role: 'host' | 'guest' }) {
  const app = useApp();
  const mode = useAppState(groupModeOf);
  const incompatible = useIncompatible();
  const note = incompatibleNote(incompatible);
  return (
    <div className="group-mode-block" data-testid="group-mode" data-mode={mode}>
      <div className="group-mode">
        <span className="room-label">This ride</span>
        {role === 'guest' && <ModeBadge mode={mode} />}
        {role === 'host' ? (
          <ModeSwitch
            mode={mode}
            onChange={(m) => app.setGroupMode(m)}
            testId="group-mode-switch"
          />
        ) : (
          <span className="hint">Chosen by the host</span>
        )}
      </div>
      {mode === 'rumble' && (
        <p className="hint group-mode-note">
          {role === 'host'
            ? `Everyone plays ${RUMBLE_NAME}: two item slots each, gentle hits, protection after every hit.`
            : `Two item slots each, used with the side buttons (P and L). Hits only move race positions.`}
        </p>
      )}
      {note && (
        <p className="mode-incompatible" data-testid="group-mode-incompatible" role="status">
          {`${note}: they ride along with normal power-ups and nothing can hit them.`}
        </p>
      )}
      {mode === 'normal' && <GroupPowerUps role={role} />}
    </div>
  );
}
