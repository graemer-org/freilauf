/**
 * The Card Race on the ride scene (docs/card-race.md): the two-card hand at the bottom — the
 * left card bottom left, the right card bottom right, as the side buttons — what acts on this
 * rider (own boost, shield, protection, an attack) in the middle, and a notice at the top when
 * an attack arrives or one of ours lands. Presentational parts are pure functions of their props.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  CardRaceLive,
  IncomingAttackLive,
  OutgoingAttackLive,
  PowerUpEffectLive,
  PowerUpKind,
  PowerUpLive,
} from '../../../shared/powerUps';
import {
  CARD_HINTS,
  POWER_UP_INFO,
  formatAttackLoss,
  formatCardGain,
  isAttackKind,
} from '../../../shared/powerUps';
import { useApp, useAppState } from './hooks';
import { ChallengeCard, cueText } from './PowerUpHud';
import { PowerUpIcon } from './PowerUpIcon';

export type CardRole = 'boost' | 'attack' | 'guard';

export function cardRole(kind: PowerUpKind): CardRole {
  if (kind === 'shield') return 'guard';
  return isAttackKind(kind) ? 'attack' : 'boost';
}

const SIDE_LABEL = ['Left', 'Right'] as const;

/** What an attack aimed at this rider says (one line). */
export function incomingText(a: IncomingAttackLive): string {
  const name = POWER_UP_INFO[a.kind].label;
  switch (a.result) {
    case 'hit':
      return `${a.by} played ${name} on you`;
    case 'blocked':
      return `Your shield blocked ${a.by}’s ${name}`;
    case 'protected':
      return `${a.by} played ${name} · you were protected`;
    default:
      return `${a.by} played ${name}`;
  }
}

/** What became of an attack this rider played (one line); null while nothing to say. */
export function outgoingText(o: OutgoingAttackLive): string | null {
  const name = POWER_UP_INFO[o.kind].label;
  switch (o.result) {
    case 'sent':
      return `${name} → ${o.target}`;
    case 'hit':
      return `${name} hit ${o.target}`;
    case 'blocked':
      return `${o.target}’s shield blocked your ${name}`;
    case 'protected':
      return `${o.target} is protected · the card is back`;
    case 'unavailable':
      return `${o.target} is not racing right now · the card is back`;
    case 'refused':
      return `${o.target}’s app did not take it · the card is back`;
    case 'timeout':
      return `No answer from ${o.target} · the card is back`;
  }
}

/** Card Race words for the engine's events (null: nothing to say). */
export function cardCueText(pu: PowerUpLive): string | null {
  const e = pu.event;
  if (!e) return null;
  if (e.type === 'skipped') return 'Hand full · play a card first';
  if (e.type === 'picked' && e.kind) return `${POWER_UP_INFO[e.kind].label} card`;
  if (e.type === 'challenge-won' && e.kind)
    return `Challenge met · ${POWER_UP_INFO[e.kind].label} card`;
  if (e.type === 'played' || e.type === 'hit' || e.type === 'blocked' || e.type === 'returned') {
    return null; // told by the attack notices
  }
  return cueText(e);
}

export interface CardViewProps {
  slot: 0 | 1;
  kind: PowerUpKind | null;
  note: string | null;
  target: string | null;
  onPlay: () => void;
}

/** One card of the hand: its icon, name, whom it hits, and the button/key that plays it. */
export function CardView({ slot, kind, note, target, onPlay }: CardViewProps) {
  const side = SIDE_LABEL[slot];
  const hint = slot === 0 ? CARD_HINTS.left : CARD_HINTS.right;
  if (!kind) {
    return (
      <div
        className={`cr-card is-empty cr-${side.toLowerCase()}`}
        data-testid={`card-${side.toLowerCase()}`}
        data-kind=""
      >
        <span className="cr-slot">{`${side} card`}</span>
        <span className="cr-empty-text">Ride through a gate</span>
      </div>
    );
  }
  const info = POWER_UP_INFO[kind];
  const role = cardRole(kind);
  const ready = note === null;
  return (
    <button
      type="button"
      className={`cr-card is-${role}${ready ? '' : ' is-waiting'} cr-${side.toLowerCase()}`}
      data-testid={`card-${side.toLowerCase()}`}
      data-kind={kind}
      data-ready={ready}
      aria-disabled={!ready}
      aria-keyshortcuts={slot === 0 ? 'P' : 'L'}
      title={info.blurb}
      onClick={() => {
        if (ready) onPlay();
      }}
    >
      <span className="cr-slot">{side}</span>
      <span className="cr-badge" aria-hidden="true">
        <PowerUpIcon kind={kind} />
      </span>
      <span className="cr-text">
        <strong className="cr-name">{info.label}</strong>
        <span className="cr-hint" data-testid={`card-${side.toLowerCase()}-hint`}>
          {note ?? (target ? `→ ${target} · ${hint}` : hint)}
        </span>
      </span>
    </button>
  );
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

function Ring({ left, kind, tone }: { left: number; kind: PowerUpKind | null; tone: CardRole }) {
  const f = Math.max(0, Math.min(1, left));
  return (
    <span className={`cr-ring is-${tone}`} aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle className="cr-ring-track" cx="18" cy="18" r={RING_R} />
        <circle
          className="cr-ring-fill"
          cx="18"
          cy="18"
          r={RING_R}
          strokeDasharray={RING_C.toFixed(2)}
          strokeDashoffset={(RING_C * (1 - f)).toFixed(2)}
        />
      </svg>
      {kind ? <PowerUpIcon kind={kind} /> : <span className="cr-ring-dot" />}
    </span>
  );
}

function Chip({
  testId,
  tone,
  kind,
  left,
  title,
  detail,
}: {
  testId: string;
  tone: CardRole;
  kind: PowerUpKind | null;
  left: number;
  title: string;
  detail: string;
}) {
  return (
    <div className={`cr-chip is-${tone}`} data-testid={testId} role="status">
      <Ring left={left} kind={kind} tone={tone} />
      <span className="cr-text">
        <strong className="cr-name">{title}</strong>
        <span className="cr-hint">{detail}</span>
      </span>
    </div>
  );
}

/** What acts on this rider now: own boost, an attack, the shield, protection. */
export function CardEffects({
  effect,
  cards,
}: {
  effect: PowerUpEffectLive | null;
  cards: CardRaceLive;
}) {
  const chips = [];
  if (cards.attack) {
    const a = cards.attack;
    const s = Math.ceil(a.remainingS);
    chips.push(
      <Chip
        key="attack"
        testId="card-attack"
        tone="attack"
        kind={a.kind}
        left={a.durationS > 0 ? a.remainingS / a.durationS : 0}
        title={a.kind === 'fog' ? 'Fog · gaps hidden' : POWER_UP_INFO[a.kind].label}
        detail={`from ${a.by} · ${s} s`}
      />,
    );
  }
  if (effect) {
    const s = Math.ceil(effect.remainingS);
    chips.push(
      <Chip
        key="boost"
        testId="card-boost"
        tone="boost"
        kind={effect.kind}
        left={
          effect.phase === 'armed'
            ? 1
            : effect.durationS > 0
              ? effect.remainingS / effect.durationS
              : 0
        }
        title={POWER_UP_INFO[effect.kind].label}
        detail={effect.phase === 'armed' ? 'Armed · waits for a descent' : `Active · ${s} s`}
      />,
    );
  }
  if (cards.shield) {
    chips.push(
      <Chip
        key="shield"
        testId="card-shield"
        tone="guard"
        kind="shield"
        left={cards.shield.durationS > 0 ? cards.shield.remainingS / cards.shield.durationS : 0}
        title="Shield up"
        detail={`Blocks the next attack · ${Math.ceil(cards.shield.remainingS)} s`}
      />,
    );
  }
  if (cards.protection) {
    chips.push(
      <Chip
        key="protection"
        testId="card-protection"
        tone="guard"
        kind={null}
        left={
          cards.protection.durationS > 0
            ? cards.protection.remainingS / cards.protection.durationS
            : 0
        }
        title="Protected"
        detail={`No attack lands · ${Math.ceil(cards.protection.remainingS)} s`}
      />,
    );
  }
  if (chips.length === 0) return null;
  return <div className="cr-effects">{chips}</div>;
}

/** "+12 m from cards · −8 m from attacks" (only the parts that are not zero). */
export function raceLine(cards: CardRaceLive): string | null {
  const parts = [];
  if (Math.round(cards.gainM) > 0) parts.push(formatCardGain(cards.gainM));
  if (Math.round(cards.lossM) < 0) parts.push(formatAttackLoss(cards.lossM));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface CardHandViewProps {
  pu: PowerUpLive;
  /** A notice to show at the top (an attack, a result, a card cue), or null. */
  notice?: { text: string; tone: CardRole | 'quiet' } | null;
  onPlay: (slot: 0 | 1) => void;
  onDismiss: () => void;
}

/** Presentational: the Card Race layer of the scene. */
export function CardHandView({ pu, notice, onPlay, onDismiss }: CardHandViewProps) {
  const cards = pu.cards!;
  const line = raceLine(cards);
  return (
    <div
      className="cr-layer"
      data-testid="card-hand"
      data-left={cards.slots[0] ?? ''}
      data-right={cards.slots[1] ?? ''}
      data-attack={cards.attack?.kind ?? ''}
      data-shield={cards.shield ? 'up' : ''}
      data-protected={cards.protection ? 'yes' : ''}
    >
      {notice && (
        <p className={`cr-notice is-${notice.tone}`} data-testid="card-notice" role="status">
          {notice.text}
        </p>
      )}
      <div className="cr-hand" role="group" aria-label="Your cards">
        {([0, 1] as const).map((slot) => (
          <CardView
            key={slot}
            slot={slot}
            kind={cards.slots[slot] ?? null}
            note={cards.slotNotes[slot] ?? null}
            target={cards.slotTargets[slot] ?? null}
            onPlay={() => onPlay(slot)}
          />
        ))}
        <div className="cr-middle">
          {pu.challenge && <ChallengeCard challenge={pu.challenge} onDismiss={onDismiss} />}
          <CardEffects effect={pu.effect} cards={cards} />
          {line && (
            <p
              className="cr-line"
              data-testid="card-race-line"
              title="Your place in the race includes this; your ride's distance does not."
            >
              {line}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Picks the notice to show: the newest of an incoming attack, the result of an attack this
 * rider played, or a card cue, each for a few seconds; nothing for what was there at mount.
 */
function useCardNotice(pu: PowerUpLive | null): CardHandViewProps['notice'] {
  type Shown = { text: string; tone: CardRole | 'quiet'; key: string };
  const seen = useRef<{ inc: number; out: string; ev: number } | null>(null);
  const latest = useRef(pu);
  latest.current = pu;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<Shown | null>(null);
  const active = pu?.cards !== undefined;
  const incSeq = pu?.cards?.incoming?.seq ?? 0;
  const out = pu?.cards?.outgoing ?? null;
  const outKey = out ? `${out.seq}:${out.result}` : '';
  const evSeq = pu?.event?.seq ?? 0;
  useEffect(() => {
    const p = latest.current;
    if (!active || !p?.cards) return;
    const prev = seen.current;
    seen.current = { inc: incSeq, out: outKey, ev: evSeq };
    if (!prev) return;
    const inc = p.cards.incoming;
    const o = p.cards.outgoing;
    let next: Shown | null = null;
    if (inc && incSeq !== prev.inc) {
      next = {
        text: incomingText(inc),
        tone: inc.result === 'hit' ? 'attack' : 'guard',
        key: `in${incSeq}`,
      };
    } else if (o && outKey !== prev.out) {
      const text = outgoingText(o);
      const tone = o.result === 'hit' ? 'attack' : o.result === 'sent' ? 'quiet' : 'guard';
      if (text) next = { text, tone, key: `out${outKey}` };
    } else if (p.event && evSeq !== prev.ev) {
      const text = cardCueText(p);
      if (text)
        next = { text, tone: p.event.type === 'skipped' ? 'quiet' : 'boost', key: `ev${evSeq}` };
    }
    if (!next) return;
    const shown = next;
    setNotice(shown);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice((n) => (n?.key === shown.key ? null : n)), 4500);
  }, [active, incSeq, outKey, evSeq]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return notice ? { text: notice.text, tone: notice.tone } : null;
}

/** The Card Race layer on the ride scene, fed by the live state. */
export function CardHand() {
  const app = useApp();
  const pu = useAppState((s) => s.live?.powerUps ?? null);
  const notice = useCardNotice(pu);
  if (!pu?.cards) return null;
  return (
    <CardHandView
      pu={pu}
      notice={notice}
      onPlay={(slot) => void app.playCard(slot, 'ui')}
      onDismiss={() => app.dismissPowerUpChallenge()}
    />
  );
}
