import { setUi, store, updateSettings } from '../controller';
import { formatAgo } from '../format';
import { useStore } from '../store';
import type { ConnectionState } from '../types';
import { MenuIcon, MoonIcon, SettingsIcon, SunIcon } from './Icons';
import { BASE_HOST } from '../../platform/env';

const LABELS: Record<ConnectionState['status'], string> = {
  connecting: 'Connecting',
  live: 'Live',
  challenge: 'Security check',
  verifying: 'Verifying',
  offline: 'Offline',
  blocked: 'Web preview',
  error: 'Problem',
};

const MODE_LABELS = { direct: 'direct', bridge: 'via site tab', web: 'web page' } as const;

export function StatusPill() {
  const connection = useStore(store, (s) => s.connection);
  const tone =
    connection.status === 'live'
      ? 'ok'
      : connection.status === 'connecting' || connection.status === 'verifying' || connection.status === 'challenge'
        ? 'wait'
        : connection.status === 'blocked'
          ? 'muted'
          : 'bad';
  const title =
    connection.status === 'live'
      ? `Session created ${formatAgo(connection.fetchedAt)} · requests go from this browser straight to ${BASE_HOST} (${MODE_LABELS[connection.mode]})`
      : (connection.message ?? LABELS[connection.status]);

  return (
    <button type="button" className="status-pill" data-tone={tone} title={title} onClick={() => setUi({ settingsOpen: true })}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-label">{LABELS[connection.status]}</span>
      {connection.status === 'live' && <span className="status-mode">{MODE_LABELS[connection.mode]}</span>}
    </button>
  );
}

export function TopBar() {
  const title = useStore(store, (s) => s.active?.title ?? '');
  const theme = useStore(store, (s) => s.settings.theme);
  const isNight = theme === 'night' || (theme === 'system' && document.documentElement.dataset.theme === 'night');

  return (
    <header className="topbar">
      <button type="button" className="icon-button menu-button" onClick={() => setUi({ sidebarOpen: true })} aria-label="Open conversations">
        <MenuIcon />
      </button>
      <div className="running-head" aria-live="off">
        {title || 'New conversation'}
      </div>
      <div className="topbar-actions">
        <StatusPill />
        <button
          type="button"
          className="icon-button"
          onClick={() => updateSettings({ theme: isNight ? 'paper' : 'night' })}
          aria-label={isNight ? 'Switch to paper theme' : 'Switch to night theme'}
          title={isNight ? 'Paper' : 'Night'}
        >
          {isNight ? <SunIcon /> : <MoonIcon />}
        </button>
        <button type="button" className="icon-button" onClick={() => setUi({ settingsOpen: true })} aria-label="Settings" title="Settings">
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
