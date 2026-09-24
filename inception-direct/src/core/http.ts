import { InceptionError, summariseBody } from './errors';

/** Anything shaped like window.fetch — direct fetch, or the site-tab bridge. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CHALLENGE_BODY = /Vercel Security Checkpoint|vercel\/security\/static\/challenge|challenge-platform|cf-chl|Just a moment\.\.\./i;

/**
 * Detects a bot checkpoint (Vercel Firewall challenge, or Cloudflare's).
 * Vercel answers challenged requests with 429 + `x-vercel-mitigated: challenge`
 * (verified 2026-09-24 against chat.inceptionlabs.ai from a non-browser client).
 */
export async function isChallengeResponse(res: Response): Promise<boolean> {
  const mitigated = (res.headers.get('x-vercel-mitigated') || '').toLowerCase();
  if (mitigated === 'challenge' || mitigated === 'deny') return true;
  if (res.headers.get('cf-mitigated') === 'challenge') return true;
  if (res.status !== 429 && res.status !== 403 && res.status !== 503) return false;
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return false;
  const body = await safeText(res.clone());
  return CHALLENGE_BODY.test(body);
}

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Build a descriptive error for a non-OK response. */
export async function httpError(res: Response, what: string): Promise<InceptionError> {
  const body = summariseBody(await safeText(res));
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (res.status === 429) {
    return new InceptionError('rate-limit', `Inception is rate-limiting requests from this connection (${status}).`, {
      status: res.status,
      detail: body,
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new InceptionError('auth', `${what} was refused (${status}).`, { status: res.status, detail: body });
  }
  return new InceptionError('http', `${what} failed (${status})${body ? `: ${body}` : '.'}`, {
    status: res.status,
    detail: body,
  });
}

export function challengeError(): InceptionError {
  return new InceptionError(
    'challenge',
    'Inception’s firewall wants this browser to pass a quick security check first.',
    { status: 429 },
  );
}

/** Sleep that wakes up early (rejecting) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InceptionError('aborted', 'Request cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new InceptionError('aborted', 'Request cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
