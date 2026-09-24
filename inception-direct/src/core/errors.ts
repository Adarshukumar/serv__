/**
 * One error type for everything that can go wrong while talking to Inception.
 * `kind` drives the UI: a challenge opens the security-check flow, a rate limit
 * suggests waiting, a network error offers a retry, and so on.
 */
export type InceptionErrorKind =
  /** fetch() itself failed: offline, DNS, TLS, or blocked by the browser (CORS). */
  | 'network'
  /** Vercel/Cloudflare bot checkpoint — the browser must pass a check on the site first. */
  | 'challenge'
  /** HTTP 429 without a checkpoint, after the built-in retries. */
  | 'rate-limit'
  /** 401/403 even after re-creating the session. */
  | 'auth'
  /** Any other non-2xx response. */
  | 'http'
  /** The server said something we could not understand (e.g. no token). */
  | 'protocol'
  /** The model/stream reported an error mid-answer. */
  | 'stream'
  /** The user (or the app) cancelled the request. */
  | 'aborted';

export class InceptionError extends Error {
  readonly kind: InceptionErrorKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(kind: InceptionErrorKind, message: string, options: { status?: number; detail?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InceptionError';
    this.kind = kind;
    this.status = options.status;
    this.detail = options.detail;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof InceptionError) return error.kind === 'aborted';
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError' || name === 'TimeoutError';
  }
  return false;
}

export function toInceptionError(error: unknown, fallback: InceptionErrorKind = 'network'): InceptionError {
  if (error instanceof InceptionError) return error;
  if (isAbortError(error)) return new InceptionError('aborted', 'Request cancelled.', { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  return new InceptionError(fallback, message || 'Unknown error.', { cause: error });
}

/** Trim an HTTP body down to something presentable in the UI. */
export function summariseBody(body: string, max = 240): string {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const candidate = parsed.error ?? parsed.message ?? parsed.errorText ?? parsed.detail;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, max);
    if (candidate && typeof candidate === 'object' && typeof (candidate as { message?: unknown }).message === 'string') {
      return String((candidate as { message: string }).message).slice(0, max);
    }
  } catch {
    // not JSON — fall through
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
