import { useEffect, useState } from 'react';
import { cancelVerify, connect, store, verify } from '../controller';
import { formatBytes } from '../format';
import { useStore } from '../store';
import { BASE_HOST } from '../../platform/env';
import { DownloadIcon } from './Icons';

/**
 * The packed extension, offered by the dev/preview server once `npm run zip` has run
 * (see extensionDownload() in vite.config.ts). Relative, so it follows the page.
 */
const DOWNLOAD_HREF = 'download/inception-direct.zip';

interface Download {
  href: string;
  size: number | null;
}

/**
 * Asks the page's own server (same origin — never Inception) whether the ready-built
 * extension is on offer. Only used by the web preview, and only when it's blocked.
 */
function useExtensionDownload(enabled: boolean): Download | null {
  const [download, setDownload] = useState<Download | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(DOWNLOAD_HREF, { method: 'HEAD', cache: 'no-store', signal: controller.signal })
      .then((res) => {
        // A dev server answers unknown paths with index.html, so insist on a zip.
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('zip')) return;
        const size = Number(res.headers.get('content-length'));
        setDownload({ href: DOWNLOAD_HREF, size: Number.isFinite(size) && size > 0 ? size : null });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return download;
}

/**
 * Explains any state that stops chatting, with the one action that fixes it.
 * Nothing is shown while connecting or live.
 */
export function ConnectionPanel() {
  const connection = useStore(store, (s) => s.connection);
  const runtime = useStore(store, (s) => s.runtime);
  const download = useExtensionDownload(runtime === 'web' && connection.status === 'blocked');

  switch (connection.status) {
    case 'blocked':
      return (
        <section className="notice" data-tone="muted" aria-live="polite">
          <h2 className="notice-title">This preview can’t reach Inception — by design.</h2>
          <p>
            {connection.message} To chat from your own browser and IP, install Mercury as a browser extension. Extension pages are allowed to
            call <strong>{BASE_HOST}</strong> directly, with the browser’s own cookies — no server in between.
          </p>
          {download ? (
            <>
              <ol className="notice-steps">
                <li>Download the ready-built extension and unzip it.</li>
                <li>
                  Open <code>chrome://extensions</code>, switch on <em>Developer mode</em>, choose <em>Load unpacked</em> and pick the unzipped
                  folder.
                </li>
                <li>Click the Mercury button in the toolbar. The session is created when the page opens.</li>
              </ol>
              <div className="notice-actions">
                <a
                  className="button button--primary notice-download"
                  href={download.href}
                  download
                  aria-label={`Download the extension${download.size ? ` (zip, ${formatBytes(download.size)})` : ''}`}
                >
                  <DownloadIcon size={17} />
                  <span>
                    Download<span className="notice-download-long"> the extension</span>
                  </span>
                  {download.size ? <span className="button-meta">zip · {formatBytes(download.size)}</span> : null}
                </a>
              </div>
              <p className="notice-aside">
                Prefer to build it yourself? Run <code>npm install</code> and <code>npm run build</code> in <code>inception-direct/</code>, then load the{' '}
                <code>dist</code> folder instead.
              </p>
            </>
          ) : (
            <ol className="notice-steps">
              <li>
                Run <code>npm install</code> and <code>npm run build</code> in <code>inception-direct/</code>.
              </li>
              <li>
                Open <code>chrome://extensions</code>, switch on <em>Developer mode</em>, choose <em>Load unpacked</em> and pick the <code>dist</code>{' '}
                folder.
              </li>
              <li>Click the Mercury button in the toolbar. The session is created when the page opens.</li>
            </ol>
          )}
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
