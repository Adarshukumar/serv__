import { connect, store, verify } from '../controller';
import { useStore } from '../store';

const REPO_URL = 'https://github.com/Adarshukumar/serv__/tree/arena/01a0d41f-serv/inception-direct';

/** Shows only actionable, truthful states. Never pretends the hosted preview can chat. */
export function ConnectionPanel() {
  const connection = useStore(store, (s) => s.connection);

  switch (connection.status) {
    case 'preview':
      return (
        <section className="notice notice--preview" data-tone="muted" aria-live="polite">
          <p className="small-caps notice-kicker">Local only · no API key</p>
          <h2 className="notice-title">To chat from your IP, run it on your computer.</h2>
          <p>
            This hosted link shows the design. It cannot read the session at chat.inceptionlabs.ai because that site blocks requests from other websites.
            No remote server, including this sandbox, can make a request from <em>your</em> IP.
          </p>
          <ol className="notice-steps">
            <li>Install Node.js 22.12+ and Chrome, Edge or Chromium on your computer.</li>
            <li>Get this <a href={REPO_URL} target="_blank" rel="noopener noreferrer">project folder</a> and open a terminal in <code>inception-direct/</code>.</li>
            <li>Run <code>npm install</code>, then <code>npm start</code>. Open <code>http://127.0.0.1:4173</code>.</li>
          </ol>
          <p className="notice-aside">
            The local companion opens a dedicated site browser, creates your session automatically, and streams the site’s real words. It binds to
            <code> 127.0.0.1</code> only; no official API key, extension or remote proxy. If Inception shows its security check, pass it in that browser window.
          </p>
        </section>
      );
    case 'challenge':
      return (
        <section className="notice" data-tone="wait" aria-live="polite">
          <h2 className="notice-title">One check on the site, then you’re in.</h2>
          <p>{connection.message ?? 'Inception asks new browsers to pass its security check.'} {connection.detail} The companion retries automatically.</p>
          <div className="notice-actions">
            <button type="button" className="button button--primary" onClick={() => void verify()}>Show site window</button>
            <button type="button" className="button" onClick={() => void connect()}>Check again</button>
          </div>
        </section>
      );
    case 'offline':
    case 'error':
      return (
        <section className="notice" data-tone="bad" aria-live="polite">
          <h2 className="notice-title">{connection.status === 'offline' ? 'Can’t reach the site from this computer.' : 'The site session could not be created.'}</h2>
          <p>{connection.message}{connection.detail && connection.detail !== connection.message ? <span className="notice-detail"> — {connection.detail}</span> : null}</p>
          <div className="notice-actions">
            <button type="button" className="button button--primary" onClick={() => void connect()}>Reconnect</button>
            <button type="button" className="button" onClick={() => void verify()}>Show site window</button>
          </div>
        </section>
      );
    default:
      return null;
  }
}
