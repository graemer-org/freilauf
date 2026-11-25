/**
 * Freilauf Rumble on the ride scene (docs/rumble.md): the two item slots at the bottom — the
 * left slot bottom left, the right slot bottom right, as the side buttons — what acts on this
 * rider (own boost, rain cape, protection, a hit) in the middle, a notice at the top when
 * something lands, and a marker at the edge while a hit flies in from behind. Presentational
 * parts are pure functions of their props.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  IncomingHitLive,
  OutgoingAttackLive,
  PowerUpEffectLive,
  PowerUpKind,
  PowerUpLive,
  RumbleLive,
} from '../../../shared/powerUps';
import {
  ITEM_HINTS,
  POWER_UP_INFO,
  formatHitLoss,
  formatItemGain,
  isHitKind,
} from '../../../shared/powerUps';
import { useApp, useAppState } from './hooks';
import { ChallengeCard, cueText } from './PowerUpHud';
import { PowerUpIcon } from './PowerUpIcon';

export type ItemRole = 'boost' | 'attack' | 'guard';

export function itemRole(kind: PowerUpKind): ItemRole {
  if (kind === 'cape') return 'guard';
  return isHitKind(kind) ? 'attack' : 'boost';
}

const SIDE_LABEL = ['Left', 'Right'] as const;

/** The item's name inside a sentence ("a water bottle", "your mud puddle"). */
const IN_TEXT: Partial<Record<PowerUpKind, string>> = {
  bottle: 'water bottle',
  puddle: 'mud puddle',
  hornets: 'hornets',
};
const inText = (k: PowerUpKind): string => IN_TEXT[k] ?? POWER_UP_INFO[k].label;

/** What a hit on this rider says (one line). */
export function incomingText(a: IncomingHitLive): string {
  const what = inText(a.kind);
  if (a.result === 'blocked') return `Your rain cape kept off ${a.by}’s ${what}`;
  if (a.result === 'protected') return `${a.by}’s ${what} · you were protected`;
  if (a.result !== 'hit') return `${a.by}’s ${what}`;
  if (a.kind === 'bottle') return `${a.by} got you with a water bottle`;
  if (a.kind === 'hornets') return `${a.by} sent hornets after you`;
  if (a.kind === 'puddle') return `You rode through ${a.by}’s mud puddle`;
  return `${a.by} got you with ${what}`;
}

/** What became of an item this rider used on someone (one line); null while nothing to say. */
export function outgoingText(o: OutgoingAttackLive): string | null {
  const what = inText(o.kind);
  switch (o.result) {
    case 'sent':
      if (o.kind === 'puddle') return 'Mud puddle dropped behind you';
      return `${POWER_UP_INFO[o.kind].label} → ${o.target}`;
    case 'hit':
      if (o.kind === 'puddle') return `${o.target} rode through your mud puddle`;
      if (o.kind === 'hornets') return `Your hornets caught ${o.target}`;
      return `Your ${what} got ${o.target}`;
    case 'blocked':
      return `${o.target}’s rain cape kept off your ${what}`;
    case 'protected':
      return `${o.target} is protected · the item is back`;
    case 'unavailable':
      return `${o.target} is not racing right now · the item is back`;
    case 'refused':
      return `${o.target}’s app did not take it · the item is back`;
    case 'timeout':
      return `No answer from ${o.target} · the item is back`;
  }
}

/** Rumble words for the engine's events (null: nothing to say). */
export function itemCueText(pu: PowerUpLive): string | null {
  const e = pu.event;
  if (!e) return null;
  if (e.type === 'skipped') return 'Both slots full · use an item first';
  if (e.type === 'picked' && e.kind) return `${POWER_UP_INFO[e.kind].label} from the feed bag`;
  if (e.type === 'challenge-won' && e.kind) return `Challenge met · ${POWER_UP_INFO[e.kind].label}`;
  if (
    e.type === 'played' ||
    e.type === 'dropped' ||
    e.type === 'hit' ||
    e.type === 'blocked' ||
    e.type === 'returned'
  ) {
    return null; // told by the hit notices
  }
  return cueText(e);
}

export interface ItemSlotProps {
  slot: 0 | 1;
  kind: PowerUpKind | null;
  note: string | null;
  target: string | null;
  onUse: () => void;
}

/** One slot: the item in its pocket, its name, whom it hits, and the button/key that uses it. */
export function ItemSlot({ slot, kind, note, target, onUse }: ItemSlotProps) {
  const side = SIDE_LABEL[slot];
  const s = side.toLowerCase();
  const hint = slot === 0 ? ITEM_HINTS.left : ITEM_HINTS.right;
  if (!kind) {
    return (
      <div className={`rb-item is-empty rb-${s}`} data-testid={`item-${s}`} data-kind="">
        <span className="rb-pocket" aria-hidden="true" />
        <span className="rb-text">
          <strong className="rb-side">{`${side} slot`}</strong>
          <span className="rb-empty-text">Ride past a feed bag</span>
        </span>
      </div>
    );
  }
  const info = POWER_UP_INFO[kind];
  const role = itemRole(kind);
  const ready = note === null;
  return (
    <button
      type="button"
      className={`rb-item is-${role}${ready ? '' : ' is-waiting'} rb-${s}`}
      data-testid={`item-${s}`}
      data-kind={kind}
      data-ready={ready}
      aria-disabled={!ready}
      aria-keyshortcuts={slot === 0 ? 'P' : 'L'}
      title={info.blurb}
      onClick={() => {
        if (ready) onUse();
      }}
    >
      <span className="rb-pocket" aria-hidden="true">
        <PowerUpIcon kind={kind} />
      </span>
      <span className="rb-text">
        <span className="rb-side">{side}</span>
        <strong className="rb-name">{info.label}</strong>
        <span className="rb-hint" data-testid={`item-${s}-hint`}>
          {note ?? (target ? `→ ${target} · ${hint}` : hint)}
        </span>
      </span>
    </button>
  );
}

const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

function Ring({ left, kind, tone }: { left: number; kind: PowerUpKind | null; tone: ItemRole }) {
  const f = Math.max(0, Math.min(1, left));
  return (
    <span className={`rb-ring is-${tone}`} aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle className="rb-ring-track" cx="18" cy="18" r={RING_R} />
        <circle
          className="rb-ring-fill"
          cx="18"
          cy="18"
          r={RING_R}
          strokeDasharray={RING_C.toFixed(2)}
          strokeDashoffset={(RING_C * (1 - f)).toFixed(2)}
        />
      </svg>
      {kind ? <PowerUpIcon kind={kind} /> : <span className="rb-ring-dot" />}
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
  tone: ItemRole;
  kind: PowerUpKind | null;
  left: number;
  title: string;
  detail: string;
}) {
  return (
    <div className={`rb-chip is-${tone}`} data-testid={testId} role="status">
      <Ring left={left} kind={kind} tone={tone} />
      <span className="rb-text">
        <strong className="rb-name">{title}</strong>
        <span className="rb-hint">{detail}</span>
      </span>
    </div>
  );
}

/** "Water bottle · slowed", "Hornets · gaps hidden", "Mud puddle · slowed". */
export function hitTitle(kind: PowerUpKind): string {
  return `${POWER_UP_INFO[kind].label} · ${kind === 'hornets' ? 'gaps hidden' : 'slowed'}`;
}

/** What acts on this rider now: a hit, own boost, the rain cape, protection. */
export function RumbleEffects({
  effect,
  rumble,
}: {
  effect: PowerUpEffectLive | null;
  rumble: RumbleLive;
}) {
  const chips = [];
  if (rumble.hit) {
    const a = rumble.hit;
    chips.push(
      <Chip
        key="hit"
        testId="rumble-hit"
        tone="attack"
        kind={a.kind}
        left={a.durationS > 0 ? a.remainingS / a.durationS : 0}
        title={hitTitle(a.kind)}
        detail={`from ${a.by} · ${Math.ceil(a.remainingS)} s`}
      />,
    );
  }
  if (effect) {
    const s = Math.ceil(effect.remainingS);
    chips.push(
      <Chip
        key="boost"
        testId="rumble-boost"
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
  if (rumble.cape) {
    chips.push(
      <Chip
        key="cape"
        testId="rumble-cape"
        tone="guard"
        kind="cape"
        left={rumble.cape.durationS > 0 ? rumble.cape.remainingS / rumble.cape.durationS : 0}
        title="Rain cape on"
        detail={`Keeps off the next hit · ${Math.ceil(rumble.cape.remainingS)} s`}
      />,
    );
  }
  if (rumble.protection) {
    chips.push(
      <Chip
        key="protection"
        testId="rumble-protection"
        tone="guard"
        kind={null}
        left={
          rumble.protection.durationS > 0
            ? rumble.protection.remainingS / rumble.protection.durationS
            : 0
        }
        title="Protected"
        detail={`Nothing lands · ${Math.ceil(rumble.protection.remainingS)} s`}
      />,
    );
  }
  if (chips.length === 0) return null;
  return <div className="rb-effects">{chips}</div>;
}

/** "+12 m from items · −8 m from hits" (only the parts that are not zero). */
export function raceLine(rumble: RumbleLive): string | null {
  const parts = [];
  if (Math.round(rumble.gainM) > 0) parts.push(formatItemGain(rumble.gainM));
  if (Math.round(rumble.lossM) < 0) parts.push(formatHitLoss(rumble.lossM));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "Mud puddle ahead · 40 m": the nearest puddle of someone else ahead within 150 m. */
export function puddleAhead(rumble: RumbleLive): string | null {
  const p = rumble.puddles.find((x) => !x.own && x.aheadM > 0 && x.aheadM <= 150);
  return p ? `${p.by}’s mud puddle ahead · ${Math.max(1, Math.round(p.aheadM))} m` : null;
}

export interface ItemSlotsViewProps {
  pu: PowerUpLive;
  /** A notice to show at the top (a hit, a result, an item cue), or null. */
  notice?: { text: string; tone: ItemRole | 'quiet'; key?: string } | null;
  /** A hit flying in from behind right now (the marker at the edge), or null. */
  incoming?: { kind: PowerUpKind; by: string } | null;
  onUse: (slot: 0 | 1) => void;
  onDismiss: () => void;
}

/** Presentational: the Rumble layer of the scene. */
export function ItemSlotsView({ pu, notice, incoming, onUse, onDismiss }: ItemSlotsViewProps) {
  const rumble = pu.rumble!;
  const line = raceLine(rumble);
  const puddle = puddleAhead(rumble);
  return (
    <div
      className="rb-layer"
      data-testid="item-slots"
      data-left={rumble.slots[0] ?? ''}
      data-right={rumble.slots[1] ?? ''}
      data-hit={rumble.hit?.kind ?? ''}
      data-cape={rumble.cape ? 'on' : ''}
      data-protected={rumble.protection ? 'yes' : ''}
    >
      {notice && (
        // Keyed: each notice is a new element, so its fade-in plays again.
        <p
          key={notice.key ?? notice.text}
          className={`rb-notice is-${notice.tone}`}
          data-testid="rumble-notice"
          role="status"
        >
          {notice.text}
        </p>
      )}
      {incoming && (
        <p className="rb-incoming" data-testid="rumble-incoming" data-kind={incoming.kind}>
          <span className="rb-incoming-arrow" aria-hidden="true">
            ←
          </span>
          <PowerUpIcon kind={incoming.kind} />
          <span>{`${POWER_UP_INFO[incoming.kind].label} from ${incoming.by}`}</span>
        </p>
      )}
      <div className="rb-slots" role="group" aria-label="Your items">
        {([0, 1] as const).map((slot) => (
          <ItemSlot
            key={slot}
            slot={slot}
            kind={rumble.slots[slot] ?? null}
            note={rumble.slotNotes[slot] ?? null}
            target={rumble.slotTargets[slot] ?? null}
            onUse={() => onUse(slot)}
          />
        ))}
        <div className="rb-middle">
          {pu.challenge && <ChallengeCard challenge={pu.challenge} onDismiss={onDismiss} />}
          <RumbleEffects effect={pu.effect} rumble={rumble} />
          {puddle && (
            <p className="rb-line is-attack" data-testid="rumble-puddle-ahead">
              {puddle}
            </p>
          )}
          {line && (
            <p
              className="rb-line"
              data-testid="rumble-race-line"
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

/** How long the incoming marker shows (the bottle or swarm flying in), ms. */
export const INCOMING_MS = 1_400;

/**
 * Picks the notice to show: the newest of a hit on this rider, the result of an item this
 * rider used, or an item cue, each for a few seconds; nothing for what was there at mount. Also
 * the incoming marker while a fresh hit flies in.
 */
function useRumbleNotice(pu: PowerUpLive | null): {
  notice: ItemSlotsViewProps['notice'];
  incoming: ItemSlotsViewProps['incoming'];
} {
  type Shown = { text: string; tone: ItemRole | 'quiet'; key: string };
  const seen = useRef<{ inc: number; out: string; ev: number } | null>(null);
  const latest = useRef(pu);
  latest.current = pu;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const incTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<Shown | null>(null);
  /** A notice about a hit or an item's fate is on screen (cues wait until it is gone). */
  const shownHit = useRef(false);
  const [incoming, setIncoming] = useState<{ kind: PowerUpKind; by: string } | null>(null);
  const active = pu?.rumble !== undefined;
  const incSeq = pu?.rumble?.incoming?.seq ?? 0;
  const out = pu?.rumble?.outgoing ?? null;
  const outKey = out ? `${out.seq}:${out.result}` : '';
  const evSeq = pu?.event?.seq ?? 0;
  useEffect(() => {
    const p = latest.current;
    if (!active || !p?.rumble) return;
    const prev = seen.current;
    seen.current = { inc: incSeq, out: outKey, ev: evSeq };
    if (!prev) return;
    const inc = p.rumble.incoming;
    const o = p.rumble.outgoing;
    let next: Shown | null = null;
    if (inc && incSeq !== prev.inc) {
      next = {
        text: incomingText(inc),
        tone: inc.result === 'hit' ? 'attack' : 'guard',
        key: `in${incSeq}`,
      };
      // A thrown bottle or the swarm comes from behind: mark where it comes from.
      if (inc.kind !== 'puddle') {
        setIncoming({ kind: inc.kind, by: inc.by });
        if (incTimer.current) clearTimeout(incTimer.current);
        incTimer.current = setTimeout(() => setIncoming(null), INCOMING_MS);
      }
    } else if (o && outKey !== prev.out) {
      const text = outgoingText(o);
      const tone = o.result === 'hit' ? 'attack' : o.result === 'sent' ? 'quiet' : 'guard';
      if (text) next = { text, tone, key: `out${outKey}` };
    } else if (p.event && evSeq !== prev.ev && !shownHit.current) {
      // An item cue never pushes a notice about a hit off the screen.
      const text = itemCueText(p);
      if (text)
        next = { text, tone: p.event.type === 'skipped' ? 'quiet' : 'boost', key: `ev${evSeq}` };
    }
    if (!next) return;
    const shown = next;
    shownHit.current = !next.key.startsWith('ev');
    setNotice(shown);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      shownHit.current = false;
      setNotice((n) => (n?.key === shown.key ? null : n));
    }, 4500);
  }, [active, incSeq, outKey, evSeq]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (incTimer.current) clearTimeout(incTimer.current);
    },
    [],
  );
  return {
    notice: notice ? { text: notice.text, tone: notice.tone, key: notice.key } : null,
    incoming,
  };
}

/** The Rumble layer on the ride scene, fed by the live state. */
export function ItemSlots() {
  const app = useApp();
  const pu = useAppState((s) => s.live?.powerUps ?? null);
  const { notice, incoming } = useRumbleNotice(pu);
  if (!pu?.rumble) return null;
  return (
    <ItemSlotsView
      pu={pu}
      notice={notice}
      incoming={incoming}
      onUse={(slot) => void app.useItem(slot, 'ui')}
      onDismiss={() => app.dismissPowerUpChallenge()}
    />
  );
}
