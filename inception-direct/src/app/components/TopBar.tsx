import { openKeyEditor, setUi, store, updateSettings } from '../controller';
import { API_HOST } from '../env';
import { formatAgo } from '../format';
import { useStore } from '../store';
import type { ConnectionState } from '../types';
import { MenuIcon, MoonIcon, SettingsIcon, SunIcon } from './Icons';

const LABELS: Record<ConnectionState['status'], string> = {
  'no-key': 'Add key',
  connecting: 'Connecting',
  live: 'Live',
  auth: 'Key rejected',
  billing: 'No credit',
  offline: 'Offline',
  error: 'Problem',
};

export function StatusPill() {
  const connection = useStore(store, (s) => s.connection);
  const tone =
    connection.status === 'live'
      ? 'ok'
      : connection.status === 'connecting'
        ? 'wait'
        : connection.status === 'no-key'
          ? 'muted'
          : 'bad';
  const title =
    connection.status === 'live'
      ? `Session checked ${formatAgo(connection.checkedAt)}${connection.latencyMs ? ` · handshake ${connection.latencyMs} ms` : ''} · this browser talks to ${API_HOST} directly`
      : connection.status === 'no-key'
        ? 'Add your Inception API key to start'
        : (connection.message ?? LABELS[connection.status]);
  const needsKey = connection.status === 'no-key' || connection.status === 'auth';

  return (
    <button
      type="button"
      className="status-pill"
      data-tone={tone}
      title={title}
      onClick={() => (needsKey ? openKeyEditor() : setUi({ settingsOpen: true }))}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="status-label">{LABELS[connection.status]}</span>
      {connection.status === 'live' && connection.latencyMs ? <span className="status-mode">{connection.latencyMs} ms</span> : null}
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
