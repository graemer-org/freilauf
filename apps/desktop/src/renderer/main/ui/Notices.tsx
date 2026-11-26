import { useEffect } from 'react';
import type { Notice } from '../appStore';
import { useApp, useAppState } from './hooks';

const INFO_TIMEOUT_MS = 6000;
/** Warnings (e.g. a low battery at ride start) stay longer, then go away on their own too. */
const WARN_TIMEOUT_MS = 15_000;

function Toast({ notice }: { notice: Notice }) {
  const app = useApp();
  useEffect(() => {
    // Errors stay until dismissed; info and warn messages fade on their own.
    if (notice.kind === 'error') return;
    const ms = notice.kind === 'warn' ? WARN_TIMEOUT_MS : INFO_TIMEOUT_MS;
    const t = setTimeout(() => app.dismissNotice(notice.id), ms);
    return () => clearTimeout(t);
  }, [app, notice.id, notice.kind]);
  return (
    <li
      className={`toast toast-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid={`notice-${notice.kind}`}
    >
      <span className="toast-icon" aria-hidden="true">
        {notice.kind === 'info' ? 'i' : '!'}
      </span>
      <span className="toast-text">{notice.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => app.dismissNotice(notice.id)}
      >
        ×
      </button>
    </li>
  );
}

export function Notices() {
  const notices = useAppState((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <ul className="toasts" aria-label="Notifications">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </ul>
  );
}
