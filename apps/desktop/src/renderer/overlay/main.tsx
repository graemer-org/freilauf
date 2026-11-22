import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Overlay } from './ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay api={window.freilauf} />
  </StrictMode>,
);
