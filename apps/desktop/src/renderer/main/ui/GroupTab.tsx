import type { GroupRider } from '@freilauf/p2p';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  describeProbe,
  emptyRoomHint,
  GROUP_GUIDE_URL,
  LOCAL_TEST_SIGNALLING_URL,
  PEER_TROUBLE_HINT,
  RELAY_STATE_TEXT,
  serverLabel,
  signallingUrlKind,
  signallingUrlProblem,
} from '../../core/groupConnection';
import type {
  GroupNote,
  PeerView,
  ProbeMessage,
  RelayLinkState,
  SignallingUrlKind,
} from '../../core/groupConnection';
import { useShallow } from 'zustand/react/shallow';
import { formatGap, formatSpeed } from './format';
import { useApp, useAppState } from './hooks';

function CopyButton({
  text,
  label,
  testId,
  primary = false,
}: {
  text: string;
  label: string;
  testId?: string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={primary ? 'btn btn-primary' : 'btn btn-small'}
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

function GuideLink({ children = 'How group rides work' }: { children?: string }) {
  return (
    <a className="link" href={GROUP_GUIDE_URL} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function JoinForm({
  label = 'Join with an invite link or code',
  initial = '',
}: {
  label?: string;
  initial?: string;
}) {
  const app = useApp();
  const id = useId();
  const [code, setCode] = useState(initial);
  const trimmed = code.trim();
  return (
    <form
      className="join-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) void app.joinGroup(trimmed);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="control-row">
        <input
          id={id}
          data-testid="group-join-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={1000}
          placeholder="freilauf://join/… or ABC-DEF-GHJK-MNPQ-RSTU"
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

type TestState = { url: string; result: 'testing' | ProbeMessage } | null;

/** "Test connection" with its result line; `url` is what gets tested. */
function useServerTest(): [TestState, (url: string) => void] {
  const app = useApp();
  const [test, setTest] = useState<TestState>(null);
  const run = (url: string): void => {
    setTest({ url, result: 'testing' });
    void app.testSignallingServer(url).then(
      (result) => setTest({ url, result: describeProbe(result, url) }),
      () => setTest({ url, result: { tone: 'error', text: 'The test could not run.' } }),
    );
  };
  return [test, run];
}

function TestResult({ test, onUse }: { test: TestState; onUse?: (url: string) => void }) {
  if (!test) return null;
  if (test.result === 'testing') {
    return (
      <p
        className="probe"
        role="status"
        data-testid="group-server-test-result"
        data-result="testing"
      >
        <span className="spinner" aria-hidden="true" /> Testing {serverLabel(test.url)}…
      </p>
    );
  }
  const { tone, text, suggestion } = test.result;
  return (
    <p
      className={`probe probe-${tone}`}
      role="status"
      data-testid="group-server-test-result"
      data-result={tone}
    >
      {text}
      {suggestion && onUse && (
        <>
          {' '}
          <button type="button" className="link" onClick={() => onUse(suggestion)}>
            Use that address
          </button>
        </>
      )}
    </p>
  );
}

/** Entering the own server's address, with inline validation and a connection test. */
function ServerForm({ initial }: { initial: string }) {
  const app = useApp();
  const id = useId();
  const [text, setText] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [test, runTest] = useServerTest();
  const problem = signallingUrlProblem(text);
  const showProblem = touched && problem !== null;
  const save = (url: string): void => {
    void app.updateSettings({ group: { signallingUrl: url.trim(), useOwnServer: true } });
  };
  return (
    <form
      className="server-form"
      data-testid="group-server-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!problem) save(text);
      }}
    >
      <label htmlFor={id}>Your server address</label>
      <input
        id={id}
        data-testid="group-server-input"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
        placeholder="wss://your-server.example/signal"
        value={text}
        aria-invalid={showProblem || undefined}
        aria-describedby={`${id}-msg`}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => setTouched(text.trim() !== '')}
      />
      <p id={`${id}-msg`} className={showProblem ? 'field-error' : 'hint'}>
        {showProblem ? problem : 'Usually ends in /signal. Starts with wss:// when it has HTTPS.'}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn"
          data-testid="group-server-test"
          disabled={problem !== null || test?.result === 'testing'}
          onClick={() => runTest(text.trim())}
        >
          Test connection
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="group-server-save"
          disabled={problem !== null}
        >
          Use this server
        </button>
      </div>
      <TestResult
        test={test && test.url === text.trim() ? test : null}
        onUse={(url) => {
          setText(url);
          runTest(url);
        }}
      />
    </form>
  );
}

/** The honest one-paragraph explanation, shown wherever a ride starts or runs. */
function HowItWorks() {
  return (
    <p className="hint group-how" data-testid="group-how">
      Riders connect directly to each other. To find each other, the apps use public relay servers
      run by others; they only pass on an encrypted handshake — no Freilauf server is involved.{' '}
      <GuideLink />
    </p>
  );
}

function ReachNote({ kind }: { kind: SignallingUrlKind }) {
  if (kind === 'local') {
    return (
      <p className="callout-warn" data-testid="group-local-note">
        This server is on this computer: fine for trying it out, but friends elsewhere cannot reach
        it.
      </p>
    );
  }
  if (kind === 'lan') {
    return (
      <p className="callout-warn" data-testid="group-lan-note">
        This is a home-network address: only riders on the same network can reach it.
      </p>
    );
  }
  return null;
}

/** Advanced: rides on an own signalling server instead of the public relays. */
function OwnServer({
  useOwnServer,
  signallingUrl,
  onOpenSettings,
}: {
  useOwnServer: boolean;
  signallingUrl: string;
  onOpenSettings: () => void;
}) {
  const app = useApp();
  const kind = signallingUrlKind(signallingUrl);
  const [test, runTest] = useServerTest();
  return (
    <details className="disclosure group-advanced" data-testid="group-advanced" open={useOwnServer}>
      <summary>Advanced: use my own signalling server</summary>
      <p className="hint">
        Only needed if the public relays do not work for your group. One of you runs a small
        signalling server; everyone else just uses the invite link, which then carries its address.{' '}
        <GuideLink>How to set one up</GuideLink>
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          data-testid="group-own-server-toggle"
          checked={useOwnServer}
          onChange={(e) =>
            void app.updateSettings({ group: { useOwnServer: e.currentTarget.checked } })
          }
        />{' '}
        Use my own signalling server for rides I create
      </label>
      {kind === 'invalid' && (
        <p className="callout-warn" data-testid="group-server-invalid">
          The saved server address is not valid: {signallingUrl}
        </p>
      )}
      {useOwnServer && kind !== 'none' && kind !== 'invalid' ? (
        <div className="hint server-note" data-testid="group-server">
          <ReachNote kind={kind} />
          <p>
            Your server: <code>{signallingUrl}</code> ·{' '}
            <button
              type="button"
              className="link"
              data-testid="group-server-test"
              disabled={test?.result === 'testing'}
              onClick={() => runTest(signallingUrl)}
            >
              Test connection
            </button>{' '}
            ·{' '}
            <button type="button" className="link" onClick={onOpenSettings}>
              Change in Settings
            </button>
          </p>
          <TestResult test={test && test.url === signallingUrl ? test : null} />
        </div>
      ) : (
        <ServerForm initial={kind === 'invalid' || kind === 'none' ? '' : signallingUrl} />
      )}
      <details className="disclosure group-local">
        <summary>Just trying it out on this computer?</summary>
        <p className="hint">
          Start a signalling server here first — for example with <code>pnpm signalling</code> in
          the source folder — then use it. Only windows on this computer can join; friends elsewhere
          cannot.
        </p>
        <button
          type="button"
          className="btn btn-small"
          data-testid="group-use-local"
          onClick={() =>
            void app.updateSettings({
              group: { signallingUrl: LOCAL_TEST_SIGNALLING_URL, useOwnServer: true },
            })
          }
        >
          Use a server on this computer (for testing)
        </button>
      </details>
    </details>
  );
}

function GroupStart({ ownServer }: { ownServer: string | null }) {
  const app = useApp();
  return (
    <section className="card group-start" data-testid="group-start">
      <h2 className="page-title">Ride together</h2>
      <p className="hint">
        Create a ride and send your friends the invite link, or paste the one they sent you. Nothing
        to set up, no account.
      </p>
      {ownServer && (
        <p className="hint" data-testid="group-own-server-note">
          Rides you create use your own server, <code>{serverLabel(ownServer)}</code>.
        </p>
      )}
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
      <HowItWorks />
    </section>
  );
}

function RelayState({ state }: { state: RelayLinkState }) {
  return (
    <p
      className={`relay-state relay-${state}`}
      role="status"
      data-testid="group-relay-state"
      data-state={state}
    >
      {state === 'connecting' && <span className="spinner" aria-hidden="true" />}{' '}
      {RELAY_STATE_TEXT[state]}
    </p>
  );
}

function Notes({ notes }: { notes: GroupNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="group-notes" data-testid="group-notes">
      {notes.map((n) => (
        <li key={n.code} className="callout-warn" data-testid="group-note" data-code={n.code}>
          {n.text}
        </li>
      ))}
    </ul>
  );
}

const PEER_LABEL: Record<PeerView['state'], string> = {
  connected: 'connected',
  connecting: 'connecting…',
  trouble: 'cannot connect',
};

function PeerStatus({
  peers,
  role,
  roomCode,
  transport,
}: {
  peers: PeerView[];
  role: 'host' | 'guest';
  roomCode: string;
  transport: 'relays' | 'self-hosted';
}) {
  const othersRiding = useAppState((s) => (s.live?.group?.riders.length ?? 0) > 0);
  if (peers.length === 0) {
    if (othersRiding) return null;
    const hint = emptyRoomHint(role, roomCode, transport);
    return (
      <div className="room-empty" data-testid="group-empty" data-role={role}>
        <strong>{hint.title}</strong>
        <p className="hint">{hint.message}</p>
      </div>
    );
  }
  const trouble = peers.filter((p) => p.state === 'trouble');
  return (
    <div className="room-peers">
      <span className="room-label">In the room</span>
      <ul className="peer-list" data-testid="group-peers">
        {peers.map((p) => (
          <li
            key={p.peerId}
            className={`peer peer-${p.state}`}
            data-testid="group-peer"
            data-state={p.state}
          >
            <span className="peer-dot" aria-hidden="true" />
            {p.name}
            <span className="peer-state">{PEER_LABEL[p.state]}</span>
          </li>
        ))}
      </ul>
      {trouble.length > 0 && (
        <p className="peer-trouble-note" data-testid="group-peer-trouble">
          <strong>{`Cannot reach ${trouble.map((p) => p.name).join(', ')} directly.`}</strong>{' '}
          {PEER_TROUBLE_HINT}
        </p>
      )}
    </div>
  );
}

export function GroupTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  const app = useApp();
  const group = useAppState((s) => s.group);
  const signallingUrl = useAppState((s) => s.settings?.group.signallingUrl ?? '');
  const useOwnServer = useAppState((s) => s.settings?.group.useOwnServer ?? false);
  const kind = signallingUrlKind(signallingUrl);
  const ownServerReady = useOwnServer && kind !== 'none' && kind !== 'invalid';
  // Relays need nothing; with the own server switched on, it must be configured.
  const canCreate = !useOwnServer || ownServerReady;

  return (
    <div className="page group">
      {group.phase === 'idle' && <GroupStart ownServer={ownServerReady ? signallingUrl : null} />}

      {group.phase === 'connecting' && (
        <section className="card group-status" role="status" data-testid="group-connecting">
          <span className="spinner" aria-hidden="true" />{' '}
          {group.action === 'create'
            ? useOwnServer
              ? 'Opening a room on your server…'
              : 'Opening a ride…'
            : 'Joining the ride…'}
        </section>
      )}

      {group.phase === 'error' && (
        <section
          className="card group-error"
          role="alert"
          data-testid="group-error"
          data-failure={group.failure.kind}
        >
          <h2 className="section-title">{group.failure.title}</h2>
          <p>{group.failure.message}</p>
          <p className="group-next">
            <strong>What to do: </strong>
            {group.failure.next}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="btn"
              data-testid="group-back"
              onClick={() => app.leaveGroup()}
            >
              Back
            </button>
            {group.failure.suggestion && (
              <button
                type="button"
                className="btn"
                data-testid="group-use-suggestion"
                onClick={() => {
                  void app.updateSettings({ group: { signallingUrl: group.failure.suggestion } });
                  app.leaveGroup();
                }}
              >
                Use {group.failure.suggestion}
              </button>
            )}
            {canCreate && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="group-create"
                onClick={() => void app.createGroup()}
              >
                {group.action === 'create' ? 'Try again' : 'Create a new group ride'}
              </button>
            )}
            <GuideLink>Help with group rides</GuideLink>
          </div>
          <JoinForm key={group.input} initial={group.action === 'join' ? group.input : ''} />
        </section>
      )}

      {group.phase === 'joined' && (
        <section className="card card-clip group-room">
          <div className="invite">
            <div className="invite-text">
              <span className="room-label">Invite link</span>
              <p className="invite-link" data-testid="group-link">
                {group.joinLink}
              </p>
              <p className="hint">
                <strong>Friends only need this link.</strong> They paste it into their Group tab —
                no account, nothing to set up.
              </p>
            </div>
            <div className="button-row">
              <CopyButton
                text={group.joinLink}
                label="Copy invite link"
                testId="group-copy-link"
                primary
              />
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
          <div className="room-meta">
            <span className="room-label">
              {group.transport === 'relays' ? 'Invite code' : 'Room code'}
            </span>
            <span className="room-code" data-testid="group-code">
              {group.inviteCode}
            </span>
            <CopyButton text={group.inviteCode} label="Copy code" testId="group-copy-code" />
            <span className="hint">
              {group.transport === 'relays'
                ? 'To read out instead of sending the link: the whole code is needed, the first six characters alone do not work.'
                : 'A code alone only works for friends who have set up the same server.'}
            </span>
          </div>
          {group.transport === 'relays' && <RelayState state={group.relay} />}
          <Notes notes={group.notes} />
          <PeerStatus
            peers={group.peers}
            role={group.role}
            roomCode={group.roomCode}
            transport={group.transport}
          />
          <RiderTable />
        </section>
      )}

      {group.phase === 'joined' &&
        (group.transport === 'relays' ? (
          <HowItWorks />
        ) : (
          <p className="hint server-note" data-testid="group-server">
            Server for this ride: <code>{serverLabel(group.signallingUrl)}</code>
            {group.role === 'guest' && group.signallingUrl !== signallingUrl
              ? ' (from the invite link)'
              : ''}
          </p>
        ))}

      {group.phase !== 'joined' && group.phase !== 'connecting' && (
        <OwnServer
          useOwnServer={useOwnServer}
          signallingUrl={signallingUrl}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
