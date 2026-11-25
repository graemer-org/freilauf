import { useEffect, useRef, useState } from 'react';
import type {
  PowerUpChallengeLive,
  PowerUpEffectLive,
  PowerUpEventLive,
  PowerUpLive,
} from '../../../shared/powerUps';
import { POWER_UP_HINT, POWER_UP_INFO, formatRaceGain } from '../../../shared/powerUps';
import { ItemSlots } from './ItemSlots';
import { useApp, useAppState } from './hooks';
import { PowerUpIcon } from './PowerUpIcon';

/** Why a held power-up cannot be used right now, in plain words (null: it can). */
export function heldNote(pu: PowerUpLive, riding: boolean): string | null {
  if (pu.blocked === 'erg') return 'Kept for later · not in ERG steps';
  if (pu.blocked === 'ftpTest') return 'Kept for later · not in FTP tests';
  if (pu.blocked === 'group') return 'Off in this group ride';
  if (pu.blocked === 'off') return 'Power-ups are off in Settings';
  if (!riding) return 'Resume the ride to use it';
  if (pu.effect) return 'Wait for the current one to end';
  return null;
}

/** What a pick-up event says, briefly (null: nothing to say). */
export function cueText(event: PowerUpEventLive | null): string | null {
  if (!event) return null;
  const name = event.kind ? POWER_UP_INFO[event.kind].label : '';
  switch (event.type) {
    case 'picked':
      return `${name} picked up`;
    case 'skipped':
      return 'Already holding a power-up';
    case 'challenge-won':
      return `Challenge met · ${name}`;
    case 'challenge-failed':
      return 'Challenge missed · no matter';
    case 'expired':
      return `${name} expired unused`;
    default:
      return null;
  }
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

/** The icon inside a ring that empties as the effect runs down. */
function CountdownRing({ effect }: { effect: PowerUpEffectLive }) {
  const left =
    effect.durationS > 0 ? Math.max(0, Math.min(1, effect.remainingS / effect.durationS)) : 0;
  return (
    <span className="pu-ring" aria-hidden="true">
      <svg className="pu-ring-svg" viewBox="0 0 36 36">
        <circle className="pu-ring-track" cx="18" cy="18" r={RING_R} />
        <circle
          className={`pu-ring-fill${effect.phase === 'armed' ? ' is-armed' : ''}`}
          cx="18"
          cy="18"
          r={RING_R}
          strokeDasharray={RING_C.toFixed(2)}
          strokeDashoffset={(RING_C * (1 - left)).toFixed(2)}
        />
      </svg>
      <PowerUpIcon kind={effect.kind} />
    </span>
  );
}

export function EffectChip({ effect }: { effect: PowerUpEffectLive }) {
  const info = POWER_UP_INFO[effect.kind];
  const s = Math.ceil(effect.remainingS);
  return (
    <div
      className={`pu-card pu-effect is-${effect.phase}`}
      data-testid="powerup-effect"
      data-kind={effect.kind}
      data-phase={effect.phase}
      role="status"
    >
      <CountdownRing effect={effect} />
      <span className="pu-text">
        <strong className="pu-name">{info.label}</strong>
        <span className="pu-hint">
          {effect.phase === 'armed' ? `Armed · waits for a descent` : `Active · ${s} s`}
        </span>
      </span>
    </div>
  );
}

export function HeldCard({
  pu,
  riding,
  onUse,
}: {
  pu: PowerUpLive;
  riding: boolean;
  onUse: () => void;
}) {
  const kind = pu.held!;
  const info = POWER_UP_INFO[kind];
  const note = heldNote(pu, riding);
  const usable = pu.canActivate && note === null;
  return (
    <button
      type="button"
      className={`pu-card pu-held${usable ? '' : ' is-waiting'}`}
      data-testid="powerup-card"
      data-kind={kind}
      aria-disabled={!usable}
      title={info.blurb}
      onClick={() => {
        if (usable) onUse();
      }}
    >
      <span className="pu-badge" aria-hidden="true">
        <PowerUpIcon kind={kind} />
      </span>
      <span className="pu-text">
        <strong className="pu-name">{info.label}</strong>
        <span className="pu-hint" data-testid="powerup-hint">
          {note ?? POWER_UP_HINT}
        </span>
      </span>
    </button>
  );
}

export function ChallengeCard({
  challenge,
  onDismiss,
}: {
  challenge: PowerUpChallengeLive;
  onDismiss: () => void;
}) {
  const { targetW, powerW, holdS, heldS, phase } = challenge;
  // The track is 125 % of the target wide; the tick marks the target.
  const fill = Math.max(0, Math.min(1, powerW / (targetW * 1.25)));
  const onTarget = powerW >= targetW * 0.95;
  const s = Math.ceil(challenge.remainingS);
  return (
    <section
      className={`pu-card pu-challenge is-${phase}`}
      data-testid="powerup-challenge"
      data-phase={phase}
      aria-label="Effort challenge"
    >
      <div className="pu-challenge-head">
        <span className="pu-label">Effort challenge</span>
        <button
          type="button"
          className="pu-dismiss"
          data-testid="powerup-challenge-dismiss"
          aria-label="Not now"
          title="Not now"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <p className="pu-challenge-goal">
        Hold <strong>{`${targetW} W`}</strong>
        {` for ${holdS} s`}
      </p>
      <div className={`pu-meter${onTarget ? ' is-on' : ''}`} aria-hidden="true">
        <span className="pu-meter-fill" style={{ width: `${(fill * 100).toFixed(1)}%` }} />
        <span className="pu-meter-target" />
      </div>
      <p className="pu-challenge-foot">
        <span className="pu-now" data-testid="powerup-challenge-power">
          {`${powerW} W`}
        </span>
        <span className="pu-hint" data-testid="powerup-challenge-time">
          {phase === 'offered'
            ? `Reach it within ${s} s`
            : `Holding · ${Math.max(0, Math.ceil(holdS - heldS))} s to go`}
        </span>
      </p>
      {phase === 'holding' && (
        <div className="pu-progress" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (heldS / holdS) * 100).toFixed(1)}%` }} />
        </div>
      )}
    </section>
  );
}

/** Shows the last event's cue for a moment; nothing for the event that was there at mount. */
function useCue(event: PowerUpEventLive | null): string | null {
  const seen = useRef<number | null>(event?.seq ?? null);
  const [cue, setCue] = useState<{ text: string; seq: number } | null>(null);
  useEffect(() => {
    if (!event || event.seq === seen.current) return;
    seen.current = event.seq;
    const text = cueText(event);
    if (!text) return;
    setCue({ text, seq: event.seq });
    const t = setTimeout(() => setCue(null), 2600);
    return () => clearTimeout(t);
  }, [event]);
  return cue?.text ?? null;
}

export interface PowerUpDockViewProps {
  pu: PowerUpLive;
  riding: boolean;
  cue?: string | null;
  onUse: () => void;
  onDismiss: () => void;
}

/** Presentational: the held card or the running effect, the challenge, the gain, a cue. */
export function PowerUpDockView({ pu, riding, cue, onUse, onDismiss }: PowerUpDockViewProps) {
  const card = pu.effect ? (
    <EffectChip effect={pu.effect} />
  ) : pu.held ? (
    <HeldCard pu={pu} riding={riding} onUse={onUse} />
  ) : null;
  return (
    <div
      className="pu-dock"
      data-testid="powerup-dock"
      data-held={pu.held ?? ''}
      data-effect={pu.effect?.phase === 'active' ? pu.effect.kind : ''}
    >
      {cue && (
        <p
          className={`pu-cue${pu.event?.type === 'skipped' ? ' is-quiet' : ''}`}
          data-testid="powerup-cue"
          role="status"
        >
          {cue}
        </p>
      )}
      {pu.challenge && <ChallengeCard challenge={pu.challenge} onDismiss={onDismiss} />}
      {card}
      {pu.raceOffsetM >= 1 && (
        <p
          className="pu-gain"
          data-testid="powerup-gain"
          title="Your place in the group includes this; your ride's distance does not."
        >
          {formatRaceGain(pu.raceOffsetM)}
        </p>
      )}
    </div>
  );
}

/** The power-up dock on the ride scene (bottom right), fed by the live state. */
export function PowerUpHud() {
  const app = useApp();
  const pu = useAppState((s) => s.live?.powerUps ?? null);
  const riding = useAppState((s) => s.live?.ride.state === 'riding');
  const cue = useCue(pu?.event ?? null);
  if (!pu) return null;
  // Freilauf Rumble: the two item slots instead of the single power-up (docs/rumble.md).
  if (pu.rumble) return <ItemSlots />;
  return (
    <PowerUpDockView
      pu={pu}
      riding={riding}
      cue={cue}
      onUse={() => void app.usePowerUp('ui')}
      onDismiss={() => app.dismissPowerUpChallenge()}
    />
  );
}
