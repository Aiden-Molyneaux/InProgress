import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The window's sheets. The order holds the cascade: layers.css first, then the shared parts' sheet (parts.css) right after
// base.css, and inside components each surface in this order, marker.css last so it wins a tie (spec section 3).
import './styles/layers.css';
// Bundled faces, latin only: Vite emits the font files next to the app, so the window never fetches a font from the network.
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/parts.css';
import './styles/page.css';
import './styles/chrome.css';
import './styles/project.css';
import './styles/board.css';
import './styles/panels.css';
import './styles/done.css';
import './styles/backlog.css';
import './styles/marker.css';
import { Root } from './Root';

// The first render waits for the bundled faces, so what it measures (the tab strip scrolls its current tab into view,
// with a peek of the next) is measured in them and not left wrong when they swap in. Best effort: the files come from
// this server, so they land in milliseconds, but a face that fails or stalls holds the window back two seconds at most,
// and a strip measured in the fallback then stays as measured until the next switch or resize.
const faces = Promise.all(['1em Archivo', '1em "Martian Mono"'].map((font) => document.fonts.load(font)));
const stall = new Promise((resolve) => setTimeout(resolve, 2000));
void Promise.race([faces, stall])
  .catch((error: unknown) => console.warn('A bundled face failed to load; the window draws in the fallback face.', error))
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Root />
      </StrictMode>,
    ),
  );
