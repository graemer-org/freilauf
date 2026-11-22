import { useEffect } from 'react';
import type { Notice } from '../appStore';
import { useApp, useAppState } from './hooks';

const INFO_TIMEOUT_MS = 6000;

function Toast({ notice }: { notice: Notice }) {
  const app = useApp();
  useEffect(() => {
    // Errors stay until dismissed; info messages fade on their own.
    if (notice.kind !== 'info') return;
    const t = setTimeout(() => app.dismissNotice(notice.id), INFO_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [app, notice.id, notice.kind]);
  return (
    <li
      className={`toast toast-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid={`notice-${notice.kind}`}
    >
      <span className="toast-icon" aria-hidden="true">
        {notice.kind === 'error' ? '!' : 'i'}
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
