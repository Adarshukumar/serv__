import type { FetchLike } from '../core/http';
import { SiteTabBridge } from './bridge';
import { installHeaderRules } from './headerRules';

/**
 * How requests leave the browser. All three run in the user's own browser, on the
 * user's own IP — there is no server of ours anywhere.
 *
 * - direct: the extension page calls chat.inceptionlabs.ai itself (host permission
 *           lifts CORS; the browser attaches the site's cookies; a header rule sets
 *           Origin/Referer to the site's).
 * - bridge: the request runs inside a chat.inceptionlabs.ai tab (content script),
 *           i.e. truly same-origin. Fallback when direct mode is refused.
 * - web:    a plain web page (dev server / preview). Browsers block this with CORS
 *           for the real site; it exists for UI development and tests.
 */
export type TransportMode = 'direct' | 'bridge' | 'web';

export interface Transport {
  readonly mode: TransportMode;
  readonly fetch: FetchLike;
  /** Get ready before the first request (install rules / open the site tab). */
  prepare(): Promise<void>;
  dispose(): void;
}

export function createDirectTransport(baseUrl: string): Transport {
  let rules: Promise<boolean> | null = null;
  const ensureRules = () => (rules ??= installHeaderRules(baseUrl));
  return {
    mode: 'direct',
    async prepare() {
      await ensureRules();
    },
    fetch: async (url, init) => {
      await ensureRules();
      return fetch(url, { ...init, credentials: 'include' });
    },
    dispose() {},
  };
}

export function createBridgeTransport(baseUrl: string): Transport {
  const bridge = new SiteTabBridge(baseUrl);
  return {
    mode: 'bridge',
    prepare: () => bridge.connect(),
    fetch: bridge.fetch,
    dispose: () => bridge.dispose(),
  };
}

export function createWebTransport(): Transport {
  return {
    mode: 'web',
    async prepare() {},
    fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
    dispose() {},
  };
}
