import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import 'katex/dist/katex.min.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/prose.css';
import './styles/components.css';
import './styles/code.css';

import { App } from './App';
import { store } from './controller';
import { applySettings } from './theme';

// Apply theme and type settings before the first paint to avoid a flash.
applySettings(store.get().settings);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
