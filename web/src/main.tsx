import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The window's sheets. The order holds the cascade: layers.css first, and inside components each surface in this
// order, marker.css last so it wins a tie (spec section 3).
import './styles/layers.css';
// Bundled faces, latin only: Vite emits the font files next to the app, so the window never fetches a font from the network.
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/project.css';
import './styles/board.css';
import './styles/panels.css';
import './styles/done.css';
import './styles/backlog.css';
import './styles/marker.css';
import { App } from './App';

// The bundled faces load before the first render, so nothing is measured in a fallback face and left wrong when the
// face swaps in (the tab strip scrolls its current tab into view by measuring it). A face that fails or stalls never
// holds the window back for more than a second.
const faces = Promise.all(['1em Archivo', '1em "Martian Mono"'].map((font) => document.fonts.load(font)));
const stall = new Promise((resolve) => setTimeout(resolve, 1000));
void Promise.race([faces, stall])
  .catch(() => undefined)
  .then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
