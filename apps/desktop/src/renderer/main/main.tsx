// Placeholder entry for the main window; replaced by the real UI.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', color: '#eee', padding: 24 }}>
      <h1 data-testid="window-name">Freilauf — {window.freilauf.window}</h1>
    </main>
  );
}

document.body.style.background = '#121417';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
