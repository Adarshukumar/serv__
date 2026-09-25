import { RETRY_BASE_MS, RETRY_MAX_MS } from './config';
import { abortedError, InceptionError, parseApiError, type InceptionErrorKind } from './errors';

/** Anything shaped like window.fetch (tests pass a programmable one). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Throw away a body we won't read, so the connection can be reused. */
export function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** 408/425/429 and 5xx are worth retrying after a pause; everything else is final. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function kindForStatus(status: number): InceptionErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 404) return 'model';
  if (status === 400 || status === 413 || status === 422) return 'invalid';
  if (status === 429) return 'rate-limit';
  if (status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  return 'protocol';
}

const MESSAGES: Record<InceptionErrorKind, string> = {
  'no-key': 'Add your Inception API key to start.',
  auth: 'Inception didn’t accept this API key.',
  billing: 'Your Inception account is out of credit, or billing is inactive.',
  model: 'This model isn’t available for your account.',
  invalid: 'Inception refused the request.',
  'rate-limit': 'Inception is rate-limiting this key right now.',
  overloaded: 'Mercury is overloaded right now.',
  server: 'Inception had a server error.',
  network: 'Couldn’t reach Inception.',
  stream: 'The answer stream broke off.',
  protocol: 'Inception sent a response this app didn’t understand.',
  aborted: 'Request cancelled.',
};

/** Turn a non-OK response into a descriptive error (the API's own message goes in `detail`). */
export async function errorFromResponse(res: Response): Promise<InceptionError> {
  const body = await safeText(res);
  const api = parseApiError(body);
  const kind = kindForStatus(res.status);
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  // For invalid requests the API's message is the useful part ("context length exceeded…").
  const message = kind === 'invalid' && api?.message ? api.message : MESSAGES[kind];
  const detail = [api?.message && api.message !== message ? api.message : '', api?.code ? `(${api.code})` : `(${status})`]
    .filter(Boolean)
    .join(' ');
  return new InceptionError(kind, message, { status: res.status, code: api?.code, detail });
}

export function defaultMessage(kind: InceptionErrorKind): string {
  return MESSAGES[kind];
}

/** Exponential backoff with ±25 % jitter: ~1 s, 2 s, 4 s … capped. */
export function retryDelay(attempt: number, baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** Sleep that wakes up early (rejecting) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * An AbortController that also aborts when any of the given signals does
 * (AbortSignal.any where available, a manual link elsewhere).
 */
export function linkedController(...signals: (AbortSignal | undefined)[]): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { controller, unlink: () => cleanups.forEach((fn) => fn()) };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
