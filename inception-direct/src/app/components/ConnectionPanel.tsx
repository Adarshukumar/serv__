import { LINKS } from '../../core/config';
import { connect, openKeyEditor, store } from '../controller';
import { API_HOST } from '../env';
import { useStore } from '../store';
import { ExternalIcon } from './Icons';
import { KeyCard } from './KeyCard';

/**
 * Whatever stands between you and a live session, with the action that fixes it.
 * Nothing is shown while connecting or live.
 */
export function ConnectionPanel() {
  const connection = useStore(store, (s) => s.connection);
  const editing = useStore(store, (s) => s.ui.keyEditor || s.ui.keyCheck);

  if (connection.status === 'no-key' || connection.status === 'auth' || editing) return <KeyCard />;

  switch (connection.status) {
    case 'billing':
      return (
        <section className="notice" data-tone="bad" aria-live="polite">
          <h2 className="notice-title">Your Inception account needs credit.</h2>
          <p>
            {connection.message} The free tokens may be used up, or billing isn’t active yet.
            {connection.detail ? <span className="notice-detail"> {connection.detail}</span> : null}
          </p>
          <div className="notice-actions">
            <a className="button button--primary" href={LINKS.billing} target="_blank" rel="noopener noreferrer">
              Open billing <ExternalIcon size={14} />
            </a>
            <button type="button" className="button" onClick={() => void connect()}>
              Try again
            </button>
            <button type="button" className="button" onClick={openKeyEditor}>
              Use another key
            </button>
          </div>
        </section>
      );

    case 'offline':
      return (
        <section className="notice" data-tone="bad" aria-live="polite">
          <h2 className="notice-title">Can’t reach {API_HOST}.</h2>
          <p>
            {connection.detail ?? connection.message} It reconnects by itself when the network comes back.
          </p>
          <div className="notice-actions">
            <button type="button" className="button button--primary" onClick={() => void connect()}>
              Reconnect
            </button>
          </div>
        </section>
      );

    case 'error':
      return (
        <section className="notice" data-tone="bad" aria-live="polite">
          <h2 className="notice-title">The session couldn’t start.</h2>
          <p>
            {connection.message}
            {connection.detail ? <span className="notice-detail"> {connection.detail}</span> : null}
          </p>
          <div className="notice-actions">
            <button type="button" className="button button--primary" onClick={() => void connect()}>
              Reconnect
            </button>
            <button type="button" className="button" onClick={openKeyEditor}>
              Change key
            </button>
          </div>
        </section>
      );

    default:
      return null;
  }
}
