import type { Settings } from './types';

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let current: Settings | null = null;

/** Reflect typographic settings on <html>: theme, reading face and reading size. */
export function applySettings(settings: Settings): void {
  current = settings;
  const root = document.documentElement;
  const theme = settings.theme === 'system' ? (media?.matches ? 'night' : 'paper') : settings.theme;
  root.dataset.theme = theme;
  root.dataset.face = settings.readingFace;
  root.style.setProperty('--reading-size', `${settings.readingSize}px`);
  root.style.colorScheme = theme === 'night' ? 'dark' : 'light';
}

media?.addEventListener('change', () => {
  if (current?.theme === 'system') applySettings(current);
});
