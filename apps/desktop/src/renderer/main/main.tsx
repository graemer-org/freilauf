import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './appStore';
import { webRtcGroupConnector } from './groupConnector';
import { MainApp } from './ui';

const app = new App(window.freilauf, webRtcGroupConnector);
window.addEventListener('beforeunload', () => app.dispose());

// Render first so the window paints immediately; init fills the store.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MainApp app={app} />
  </StrictMode>,
);
app.init().catch((err: unknown) => {
  console.error('Startup failed', err);
  app.notify('error', `Startup failed: ${err instanceof Error ? err.message : String(err)}`);
});
