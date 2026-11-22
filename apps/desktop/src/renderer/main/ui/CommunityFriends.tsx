import { useId, useState } from 'react';
import type { Visibility } from '@freilauf/community';
import type { BlockedContactView, ContactView } from '../../core/communityService';
import { VISIBILITY_LABEL, formatAgeHours, formatSince, sessionText } from './communityView';
import { Toggle } from './fields';
import { useApp, useAppState } from './hooks';

const VISIBILITIES: readonly Visibility[] = ['none', 'totals', 'everything'];

function VisibilitySelect({
  value,
  label,
  testId,
  onChange,
}: {
  value: Visibility;
  label: string;
  testId: string;
  onChange: (v: Visibility) => void;
}) {
  const id = useId();
  return (
    <span className="cm-vis">
      <label htmlFor={id} className="cm-vis-label">
        {label}
      </label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as Visibility)}
      >
        {VISIBILITIES.map((v) => (
          <option key={v} value={v}>
            {VISIBILITY_LABEL[v]}
          </option>
        ))}
      </select>
    </span>
  );
}

function standingText(c: ContactView): string {
  if (!c.standing) return 'shares nothing with you';
  const age = formatAgeHours(c.standing.ageHours);
  return c.standing.viaName
    ? `totals from ${age}, via ${c.standing.viaName}`
    : `totals from ${age}`;
}

function ContactRow({ c }: { c: ContactView }) {
  const app = useApp();
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
  const [alias, setAlias] = useState(c.alias ?? '');
  const [error, setError] = useState<string | null>(null);
  const renameId = useId();
  const result = (r: { ok: true } | { ok: false; error: string }): boolean => {
    setError(r.ok ? null : r.error);
    return r.ok;
  };
  return (
    <li className="cm-contact" data-testid="contact-row" data-present={c.present || undefined}>
      <div className="cm-contact-info">
        <span className="cm-contact-name">
          {c.displayName}
          {c.present && <span className="tag tag-accent">here now</span>}
        </span>
        <span className="cm-contact-meta">
          {c.alias && <>calls themself {c.name} · </>}
          {c.present
            ? 'in this session'
            : `last seen ${formatSince(Date.now(), c.lastSeen)}`} ·{' '}
          <span className={c.standing?.stale ? 'cm-stale-text' : undefined}>{standingText(c)}</span>
        </span>
      </div>
      <VisibilitySelect
        label="They see"
        testId="contact-visibility"
        value={c.visibility}
        onChange={(v) => result(app.setContactVisibility(c.riderId, v))}
      />
      <div className="cm-contact-actions button-row">
        <button
          type="button"
          className="btn btn-small"
          data-testid="contact-rename"
          disabled={mode !== 'view'}
          onClick={() => {
            setAlias(c.alias ?? '');
            setMode('rename');
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          data-testid="contact-remove"
          disabled={mode !== 'view'}
          onClick={() => setMode('remove')}
        >
          Remove
        </button>
      </div>
      {mode === 'rename' && (
        <form
          className="cm-contact-panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (result(app.renameContact(c.riderId, alias.trim() || null))) setMode('view');
          }}
        >
          <label htmlFor={renameId} className="cm-panel-label">
            Your name for {c.name}
          </label>
          <span className="control-row">
            <input
              id={renameId}
              type="text"
              autoComplete="off"
              maxLength={32}
              placeholder={c.name}
              data-testid="contact-alias"
              value={alias}
              onChange={(e) => setAlias(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="btn btn-small btn-primary"
              data-testid="contact-alias-save"
            >
              Save
            </button>
            <button type="button" className="btn btn-small" onClick={() => setMode('view')}>
              Cancel
            </button>
          </span>
          <span className="hint">Only you see this name. Leave it empty to use theirs.</span>
        </form>
      )}
      {mode === 'remove' && (
        <div
          className="cm-contact-panel cm-remove"
          role="group"
          aria-label={`Remove ${c.displayName}?`}
        >
          <p>
            <strong>Remove {c.displayName}?</strong> This blocks them: their totals and everything
            that reached you through them are deleted, they are not added again when you ride
            together, and you share nothing in a session while they are in it. You can unblock them
            later.
          </p>
          <span className="button-row">
            <button
              type="button"
              className="btn btn-small btn-danger-solid"
              data-testid="contact-remove-confirm"
              onClick={() => {
                if (result(app.removeContact(c.riderId))) setMode('view');
              }}
            >
              Remove and block
            </button>
            <button type="button" className="btn btn-small" onClick={() => setMode('view')}>
              Keep
            </button>
          </span>
        </div>
      )}
      {error && (
        <span className="field-error cm-contact-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function BlockedRow({ b }: { b: BlockedContactView }) {
  const app = useApp();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="cm-blocked" data-testid="blocked-row">
      <span className="cm-contact-info">
        <span className="cm-contact-name">{b.name}</span>
        <span className="cm-contact-meta">
          removed · last seen {formatSince(Date.now(), b.since)}
        </span>
      </span>
      <button
        type="button"
        className="btn btn-small"
        data-testid="contact-unblock"
        onClick={() => {
          const r = app.unblockContact(b.riderId);
          setError(r.ok ? null : r.error);
        }}
      >
        Unblock
      </button>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function SessionRule() {
  const session = useAppState((s) => s.community.session);
  return (
    <div className="cm-rule" data-testid="session-rule">
      <p>
        <strong>In a group session everyone present receives the same data.</strong> So Freilauf
        shares only what the most restricted person present may see of you.
      </p>
      {session.active && (
        <p className="cm-rule-now" role="status" data-testid="session-level">
          <span
            className={`cm-level-mark${session.level === 'totals' || session.level === 'everything' ? ' is-on' : ''}`}
            aria-hidden="true"
          />
          {sessionText(session.level)}
        </p>
      )}
    </div>
  );
}

export function FriendsSection() {
  const app = useApp();
  const contacts = useAppState((s) => s.community.contacts);
  const blocked = useAppState((s) => s.community.blocked);
  const profile = useAppState((s) => s.community.profile);
  const defaultId = useId();
  return (
    <section
      className="cm-friends"
      aria-labelledby="cm-friends-title"
      data-testid="community-friends"
    >
      <div className="section-head">
        <h2 id="cm-friends-title" className="section-title">
          Friends &amp; privacy
        </h2>
        <span className="hint">Choose what each friend may see of you</span>
      </div>
      <SessionRule />
      {contacts.length === 0 ? (
        <div className="card cm-friends-empty" data-testid="contacts-empty">
          <p className="hint">
            No friends yet. Everyone you ride with in a group session is added here, with “
            {VISIBILITY_LABEL[profile.defaultVisibility]}” as what they may see.
          </p>
        </div>
      ) : (
        <ul className="list card cm-contacts" aria-label="Friends">
          {contacts.map((c) => (
            <ContactRow key={c.riderId} c={c} />
          ))}
        </ul>
      )}

      <h3 className="subhead">For new friends and their friends</h3>
      <div className="card rows">
        <div className="field">
          <div className="field-text">
            <label htmlFor={defaultId}>New friends see</label>
            <span className="field-hint">
              Applies to riders you meet from now on; existing friends keep their setting.
            </span>
          </div>
          <div className="field-control">
            <select
              id={defaultId}
              data-testid="community-default-visibility"
              value={profile.defaultVisibility}
              onChange={(e) => app.setDefaultVisibility(e.currentTarget.value as Visibility)}
            >
              {VISIBILITIES.map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_LABEL[v]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Toggle
          label="Friends of friends may see my totals"
          testId="community-fof"
          checked={profile.friendsOfFriends}
          hint={
            <>
              Off: a friend you both ride with passes your weekly and monthly totals on only to your
              friends who may see them anyway. On: also to riders you have never ridden with —
              except riders you set to Nothing or removed, whose rider ids are then listed in what
              you share. Best efforts are never passed on.
            </>
          }
          onChange={(on) => app.setFriendsOfFriends(on)}
        />
      </div>

      {blocked.length > 0 && (
        <>
          <h3 className="subhead">Removed riders</h3>
          <ul className="list card cm-blocked-list" aria-label="Removed riders">
            {blocked.map((b) => (
              <BlockedRow key={b.riderId} b={b} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
