import { cancelVerify, connect, store, verify } from '../controller';
import { useStore } from '../store';
import { BASE_HOST } from '../../platform/env';

/**
 * Explains any state that stops chatting, with the one action that fixes it.
 * Nothing is shown while connecting or live.
 */
export function ConnectionPanel() {
  const connection = useStore(store, (s) => s.connection);
  const runtime = useStore(store, (s) => s.runtime);

  switch (connection.status) {
    case 'blocked':
      return (
        <section className="notice" data-tone="muted" aria-live="polite">
          <h2 className="notice-title">This preview can’t reach Inception — by design.</h2>
          <p>
            {connection.message} To chat from your own browser and IP, load this project as a browser extension. Extension pages are allowed to
            call <strong>{BASE_HOST}</strong> directly, with the browser’s own cookies — no server in between.
          </p>
          <ol className="notice-steps">
            <li>
              Run <code>npm install</code> and <code>npm run build</code> in <code>inception-direct/</code>.
            </li>
            <li>
              Open <code>chrome://extensions</code>, switch on <em>Developer mode</em>, choose <em>Load unpacked</em> and pick the <code>dist</code> folder.
            </li>
            <li>Click the Mercury button in the toolbar. The session is created when the page opens.</li>
          </ol>
        </section>
      );

    case 'challenge':
      return (
        <section className="notice" data-tone="wait" aria-live="polite">
          <h2 className="notice-title">One quick check, then you’re in.</h2>
          <p>
            {connection.message ?? 'Inception’s firewall asks new browsers to pass a short, automatic check.'} It runs on {BASE_HOST} in your own
            browser; the tab closes itself when the site is reachable.
          </p>
          <div className="notice-actions">
            {runtime === 'extension' ? (
              <button type="button" className="button button--primary" onClick={() => void verify()}>
                Run the security check
              </button>
            ) : null}
            <button type="button" className="button" onClick={() => void connect()}>
              Try again
            </button>
          </div>
        </section>
      );

    case 'verifying':
      return (
        <section className="notice" data-tone="wait" aria-live="polite">
          <h2 className="notice-title">Verifying this browser…</h2>
          <p className="notice-progress">{connection.progress ?? `Waiting for ${BASE_HOST}…`}</p>
          <div className="notice-actions">
            <button type="button" className="button" onClick={cancelVerify}>
              Cancel
            </button>
          </div>
        </section>
      );

    case 'offline':
    case 'error':
      return (
        <section className="notice" data-tone="bad" aria-live="polite">
          <h2 className="notice-title">{connection.status === 'offline' ? `Can’t reach ${BASE_HOST}.` : 'The session could not be created.'}</h2>
          <p>
            {connection.message}
            {connection.detail && connection.detail !== connection.message ? <span className="notice-detail"> — {connection.detail}</span> : null}
          </p>
          <div className="notice-actions">
            <button type="button" className="button button--primary" onClick={() => void connect()}>
              Reconnect
            </button>
          </div>
        </section>
      );

    default:
      return null;
  }
}
