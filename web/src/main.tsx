import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled faces: Vite emits the font files next to the app, so the window never fetches a font from the network.
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-900.css';
import '@fontsource/dm-mono/latin-500.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
