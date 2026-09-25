import { ENDPOINTS, SESSION_MAX_AGE_MS } from './config';
import { InceptionError, toInceptionError } from './errors';
import { challengeError, httpError, isChallengeResponse, type FetchLike } from './http';

export type SessionStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface SessionState {
  status: SessionStatus;
  token: string | null;
  /** Local clock (ms) when the current token was received — used for freshness. */
  fetchedAt: number | null;
  /** Issue time encoded in the token's first segment (server clock), informational. */
  issuedAt: number | null;
  error: InceptionError | null;
  /** How many tokens this manager has obtained. */
  refreshCount: number;
}

export interface SessionOptions {
  baseUrl: string;
  fetch: FetchLike;
  now?: () => number;
  maxAgeMs?: number;
}

type Listener = (state: SessionState) => void;

/**
 * Owns the anonymous session with chat.inceptionlabs.ai.
 *
 * The web app does `fetch("/api/session")` on load and every 13 minutes, and sends
 * the token as `x-session-token`. The session cookie that comes with it lives in the
 * browser's own cookie jar, so nothing else needs to be stored here.
 *
 * - `refresh()` is single-flight: concurrent callers share one request.
 * - `ensure()` returns a token young enough to use, refreshing first if needed.
 * - `invalidate()` drops the token (e.g. after a 401) so the next `ensure()` refreshes.
 * - `setFetch()` is available for tests that swap the site-browser transport.
 */
export class SessionManager {
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private fetchImpl: FetchLike;
  private inflight: Promise<string> | null = null;
  private generation = 0;
  private readonly listeners = new Set<Listener>();
  private state: SessionState = {
    status: 'idle',
    token: null,
    fetchedAt: null,
    issuedAt: null,
    error: null,
    refreshCount: 0,
  };

  constructor(options: SessionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS;
  }

  getState(): SessionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Age of the current token in ms, or null without a token. */
  tokenAge(): number | null {
    return this.state.fetchedAt === null ? null : Math.max(0, this.now() - this.state.fetchedAt);
  }

  isFresh(): boolean {
    const age = this.tokenAge();
    return this.state.token !== null && age !== null && age < this.maxAgeMs;
  }

  /** Swap the fetch implementation (transport) and forget the current session. */
  setFetch(fetchImpl: FetchLike): void {
    this.fetchImpl = fetchImpl;
    this.reset();
  }

  reset(): void {
    this.generation++;
    this.inflight = null;
    this.update({ status: 'idle', token: null, fetchedAt: null, issuedAt: null, error: null });
  }

  /** Drop the token but keep the status, so the next ensure() fetches a new one. */
  invalidate(): void {
    this.update({ token: null, fetchedAt: null, issuedAt: null });
  }

  async ensure(): Promise<string> {
    if (this.isFresh() && this.state.token) return this.state.token;
    return this.refresh();
  }

  refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    // Background refreshes while live keep showing "live"; only a cold start shows "connecting".
    if (!this.state.token) this.update({ status: 'connecting', error: null });

    const request = this.createSession().then(
      (token) => {
        if (generation !== this.generation) return token; // transport changed meanwhile
        this.update({
          status: 'live',
          token,
          fetchedAt: this.now(),
          issuedAt: parseIssuedAt(token),
          error: null,
          refreshCount: this.state.refreshCount + 1,
        });
        return token;
      },
      (error: unknown) => {
        const err = toInceptionError(error);
        if (generation === this.generation) {
          this.update({ status: 'error', token: null, fetchedAt: null, issuedAt: null, error: err });
        }
        throw err;
      },
    );
    const tracked = request.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    this.inflight = tracked;
    return tracked;
  }

  private async createSession(): Promise<string> {
    const url = this.baseUrl + ENDPOINTS.session;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', credentials: 'include' });
    } catch (error) {
      const err = toInceptionError(error, 'network');
      if (err.kind === 'aborted') throw err;
      throw new InceptionError('network', `Could not reach ${hostOf(this.baseUrl)}.`, { cause: error, detail: err.message });
    }

    if (await isChallengeResponse(res)) {
      void res.body?.cancel().catch(() => {});
      throw challengeError();
    }
    if (!res.ok) throw await httpError(res, 'Creating a session');

    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw new InceptionError('protocol', 'The session endpoint did not return JSON.', { status: res.status, cause: error });
    }
    const token = typeof json === 'object' && json !== null ? (json as { token?: unknown }).token : undefined;
    if (typeof token !== 'string' || token.trim().length < 8) {
      throw new InceptionError('protocol', 'The session endpoint returned no token.', { status: res.status });
    }
    return token.trim();
  }

  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

/**
 * Tokens look like "<unix seconds>.<32 hex>.<64 hex>". The first segment matched
 * the server's clock at issue time when checked, so it is exposed as `issuedAt`.
 */
export function parseIssuedAt(token: string): number | null {
  const first = token.split('.')[0] ?? '';
  if (!/^\d{9,11}$/.test(first)) return null;
  return Number(first) * 1000;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
