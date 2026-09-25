/**
 * One error type for everything that can go wrong while talking to Inception.
 * `kind` drives the UI: a rejected key reopens the key card, no credit links to
 * billing, a rate limit suggests waiting, a network error offers a retry, and so on.
 */
export type InceptionErrorKind =
  /** No API key yet — nothing was sent. */
  | 'no-key'
  /** 401/403: the key is missing, wrong or revoked. */
  | 'auth'
  /** 402: billing inactive or the free credit is used up. */
  | 'billing'
  /** 404: the model isn't available for this account. */
  | 'model'
  /** 400/422: the request was refused as invalid (e.g. context length exceeded). */
  | 'invalid'
  /** 429 after the built-in retries. */
  | 'rate-limit'
  /** 503 after the built-in retries. */
  | 'overloaded'
  /** Other 5xx after the built-in retries. */
  | 'server'
  /** fetch() itself failed: offline, DNS, TLS, a firewall — or a timeout. */
  | 'network'
  /** The stream broke mid-answer, or the model reported an error in it. */
  | 'stream'
  /** Inception answered with something we could not understand. */
  | 'protocol'
  /** The user (or the app) cancelled the request. */
  | 'aborted';

export class InceptionError extends Error {
  readonly kind: InceptionErrorKind;
  readonly status?: number;
  /** Machine-readable code from the API's error object, e.g. `invalid_api_key`. */
  readonly code?: string;
  readonly detail?: string;

  constructor(
    kind: InceptionErrorKind,
    message: string,
    options: { status?: number; code?: string; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InceptionError';
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
  }

  /** Worth trying again as-is (later), as opposed to needing a different key/model/request. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

const RETRYABLE = new Set<InceptionErrorKind>(['rate-limit', 'overloaded', 'server', 'network', 'stream']);

export function isAbortError(error: unknown): boolean {
  if (error instanceof InceptionError) return error.kind === 'aborted';
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return (error as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

export function abortedError(cause?: unknown): InceptionError {
  return new InceptionError('aborted', 'Request cancelled.', { cause });
}

export function toInceptionError(error: unknown, fallback: InceptionErrorKind = 'network'): InceptionError {
  if (error instanceof InceptionError) return error;
  if (isAbortError(error)) return abortedError(error);
  const message = error instanceof Error ? error.message : String(error);
  return new InceptionError(fallback, message || 'Unknown error.', { cause: error });
}

export interface ApiErrorBody {
  message: string;
  type?: string;
  code?: string;
  param?: string;
}

/**
 * Read an error body. The API answers `{ error: { message, type, param, code } }`;
 * FastAPI itself may answer `{ detail: "…" }` or `{ detail: [{ msg }] }` (422).
 */
export function parseApiError(body: string): ApiErrorBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? { message: text.length > 240 ? `${text.slice(0, 239)}…` : text } : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const error = obj.error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const message = typeof e.message === 'string' ? e.message : '';
    return {
      message,
      type: typeof e.type === 'string' ? e.type : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
      param: typeof e.param === 'string' ? e.param : undefined,
    };
  }
  if (typeof error === 'string') return { message: error };

  const detail = obj.detail;
  if (typeof detail === 'string') return { message: detail };
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === 'object' && typeof (d as { msg?: unknown }).msg === 'string' ? (d as { msg: string }).msg : ''))
      .filter(Boolean);
    if (msgs.length) return { message: msgs.join('; ') };
  }
  if (typeof obj.message === 'string') return { message: obj.message };
  return null;
}
