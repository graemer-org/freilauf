// Placeholder entry for the overlay window; replaced by the real UI.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function Overlay() {
  const [power, setPower] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  useEffect(() => window.freilauf.live.onState((s) => setPower(s.ride.powerW)), []);
  useEffect(() => window.freilauf.overlay.onEditMode(setEdit), []);
  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#fff',
        background: 'rgba(0,0,0,0.55)',
        padding: 12,
        height: '100vh',
        boxSizing: 'border-box',
        outline: edit ? '2px dashed #4af' : 'none',
        // In edit mode the whole overlay is a drag handle.
        ...(edit ? { WebkitAppRegion: 'drag' } : {}),
      }}
    >
      <div data-testid="window-name">{window.freilauf.window}</div>
      <div data-testid="power">{power ?? '–'}</div>
      <div data-testid="edit-mode">{edit ? 'edit' : 'locked'}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>,
);
