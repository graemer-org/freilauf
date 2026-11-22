import type { GroupRider } from '@freilauf/p2p';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { formatGap, formatSpeed } from './format';
import { useApp, useAppState } from './hooks';

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn btn-small"
      data-testid={testId}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied('ok'),
          () => setCopied('failed'),
        );
      }}
    >
      {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

interface Row {
  key: string;
  name: string;
  gapM: number;
  powerW: number;
  heartRateBpm: number | null;
  speedMps: number;
  stale: boolean;
  local: boolean;
}

function RiderTable() {
  const riders = useAppState((s) => s.live?.group?.riders ?? null);
  // One shallow-compared object instead of the whole (4 Hz) ride snapshot.
  const me = useAppState(
    useShallow((s) => ({
      name: s.live?.localName ?? 'You',
      powerW: s.live?.ride.powerW ?? 0,
      heartRateBpm: s.live?.ride.heartRateBpm ?? null,
      speedMps: s.live?.ride.speedMps ?? 0,
    })),
  );
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = (riders ?? []).map((r: GroupRider) => ({
      key: r.peerId,
      name: r.name,
      gapM: r.gapM,
      powerW: r.powerW,
      heartRateBpm: r.heartRateBpm,
      speedMps: r.speedMps,
      stale: r.stale,
      local: false,
    }));
    list.push({ key: '__local', ...me, gapM: 0, stale: false, local: true });
    // Ahead first; the local rider goes before others at an equal gap.
    return list.sort((a, b) => b.gapM - a.gapM || Number(b.local) - Number(a.local));
  }, [riders, me]);

  return (
    <table className="riders" data-testid="group-riders">
      <thead>
        <tr>
          <th scope="col" className="num">
            #
          </th>
          <th scope="col">Rider</th>
          <th scope="col" className="num">
            Gap
          </th>
          <th scope="col" className="num">
            Power
          </th>
          <th scope="col" className="num">
            HR
          </th>
          <th scope="col" className="num">
            Speed
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.key}
            className={r.local ? 'rider-local' : r.stale ? 'rider-stale' : undefined}
            data-testid={r.local ? 'group-rider-local' : 'group-rider'}
          >
            <td className="num rank">{i + 1}</td>
            <td>
              {r.name}
              {r.local && <span className="tag">you</span>}
              {r.stale && <span className="tag">no signal</span>}
            </td>
            <td className="num">{formatGap(r.gapM)}</td>
            <td className="num">{Math.round(r.powerW)} W</td>
            <td className="num">
              {r.heartRateBpm === null ? '–' : `${Math.round(r.heartRateBpm)}`}
            </td>
            <td className="num">{formatSpeed(r.speedMps)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JoinForm() {
  const app = useApp();
  const [code, setCode] = useState('');
  const trimmed = code.trim();
  return (
    <form
      className="join-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) void app.joinGroup(trimmed);
      }}
    >
      <label htmlFor="group-join-input">Join with a code or link</label>
      <div className="control-row">
        <input
          id="group-join-input"
          data-testid="group-join-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
          placeholder="e.g. ABCD-1234 or a join link"
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="group-join"
          disabled={!trimmed}
        >
          Join
        </button>
      </div>
    </form>
  );
}

export function GroupTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const app = useApp();
  const group = useAppState((s) => s.group);
  const signallingUrl = useAppState((s) => s.settings?.group.signallingUrl ?? '');

  return (
    <div className="page group">
      {group.phase === 'idle' && (
        <section className="card group-start">
          <h2 className="page-title">Ride together</h2>
          <p className="hint">
            Create a group ride and share the code, or join someone else's. Riders connect directly
            to each other.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-big"
            data-testid="group-create"
            onClick={() => void app.createGroup()}
          >
            Create group ride
          </button>
          <p className="or">or</p>
          <JoinForm />
        </section>
      )}

      {group.phase === 'connecting' && (
        <section className="card group-status" role="status" data-testid="group-connecting">
          <span className="spinner" aria-hidden="true" /> Connecting to the group…
        </section>
      )}

      {group.phase === 'error' && (
        <section className="card group-error" role="alert" data-testid="group-error">
          <h2 className="section-title">Could not connect</h2>
          <p className="error-text">{group.message}</p>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => app.leaveGroup()}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="group-create"
              onClick={() => void app.createGroup()}
            >
              Create a new group ride
            </button>
          </div>
          <JoinForm />
        </section>
      )}

      {group.phase === 'joined' && (
        <section className="card card-clip">
          <div className="room">
            <div>
              <span className="room-label">Room code</span>
              <p className="room-code" data-testid="group-code">
                {group.roomCode}
              </p>
            </div>
            <div className="button-row">
              <CopyButton text={group.roomCode} label="Copy code" testId="group-copy-code" />
              <CopyButton text={group.joinLink} label="Copy join link" testId="group-copy-link" />
              <button
                type="button"
                className="btn btn-danger"
                data-testid="group-leave"
                onClick={() => app.leaveGroup()}
              >
                Leave
              </button>
            </div>
          </div>
          <RiderTable />
        </section>
      )}

      <p className="hint server-note" data-testid="group-server">
        Signalling server: <code>{signallingUrl}</code> ·{' '}
        <button type="button" className="link" onClick={onOpenSettings}>
          Change in Settings
        </button>
        <br />
        It must be reachable by all riders. It only introduces riders; ride data goes directly
        between them.
      </p>
    </div>
  );
}
