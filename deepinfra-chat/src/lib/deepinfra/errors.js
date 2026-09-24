/**
 * ══════════════════════════════════════════════════════════════════
 *  Error classification — one place that knows what went wrong
 * ══════════════════════════════════════════════════════════════════
 *
 *  Direct-from-the-browser calls fail in ways a Python client never sees
 *  (CORS, mixed content, opaque network errors). Every failure gets a
 *  `kind`, a human explanation and a concrete `hint` the UI can show.
 */

export const RETRY_CODES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524])
export const FATAL_CODES = new Set([400, 401, 403, 404, 405, 422])

/** Mirror of _stream()'s backoff in DeepInfra.py. */
export function backoffMs(attempt) {
  return Math.min(2000 * 2 ** attempt + Math.random() * 1000, 30000)
}

export class DeepInfraError extends Error {
  constructor({ kind, title, message, hint, status = 0, retryable = false, body = '', rung = null }) {
    super(message || title)
    this.name = 'DeepInfraError'
    this.kind = kind
    this.title = title
    this.hint = hint
    this.status = status
    this.retryable = retryable
    this.body = body
    this.rung = rung
  }

  toJSON() {
    const { kind, title, message, hint, status, retryable } = this
    return { kind, title, message, hint, status, retryable }
  }
}

export function classifyHttpError(status, bodyText, rungLabel) {
  const snippet = (bodyText || '').slice(0, 400)
  const base = { status, body: snippet, rung: rungLabel, retryable: RETRY_CODES.has(status) }

  if (status === 401) {
    return new DeepInfraError({
      ...base,
      kind: 'auth',
      title: '401 — this route needs an API key',
      message: 'DeepInfra rejected the anonymous web-embed request.',
      hint: 'Run `npm run doctor` to confirm, then paste a DeepInfra key in Settings (it is only used for this rung).',
    })
  }
  if (status === 403) {
    return new DeepInfraError({
      ...base,
      kind: 'forbidden',
      title: '403 — origin rejected',
      message: 'The upstream edge refused this origin / client fingerprint.',
      hint: 'Proxy mode sends the exact deepinfra.com header set — try it (the app falls back automatically in Auto mode).',
    })
  }
  if (status === 404) {
    return new DeepInfraError({
      ...base,
      kind: 'model',
      title: '404 — model not served',
      message: 'The model id was not found (unknown aliases are forwarded blindly, so a typo lands here).',
      hint: 'Open Settings → Sync models and pick an id from the live catalogue.',
    })
  }
  if (status === 429) {
    return new DeepInfraError({
      ...base,
      kind: 'rate',
      title: '429 — rate limited',
      message: 'Too many anonymous requests from this IP.',
      hint: 'Wait a few seconds (the client auto-retries with exponential backoff) or add a key.',
    })
  }
  if (status >= 500) {
    return new DeepInfraError({
      ...base,
      kind: 'upstream',
      title: `${status} — upstream/edge hiccup`,
      message: 'DeepInfra or its CDN failed on this attempt.',
      hint: 'Retryable — the client backs off and tries again (521 also rebuilds the session, like the Python provider).',
    })
  }
  return new DeepInfraError({
    ...base,
    kind: 'http',
    title: `${status} — request rejected`,
    message: snippet || 'The request was refused.',
    hint: status === 400 || status === 422 ? 'The payload was invalid — check max_tokens/temperature.' : 'Check the diagnostics drawer for the full exchange.',
  })
}

export function classifyNetworkError(err, { rungLabel, endpoint }) {
  const msg = String(err?.message || err)
  const isAbort = err?.name === 'AbortError' || msg.includes('aborted')

  if (isAbort) {
    return new DeepInfraError({
      kind: 'abort', title: 'Stopped', message: 'You stopped this response.',
      hint: 'The partial answer was kept.', rung: rungLabel, retryable: false,
    })
  }

  // The browser deliberately hides CORS details: it just says "Failed to fetch".
  const looksLikeCors = /failed to fetch|load failed|networkerror|network request failed/i.test(msg)
  if (looksLikeCors) {
    return new DeepInfraError({
      kind: 'cors',
      title: 'Browser blocked the direct call',
      message: `fetch(${endpoint}) never completed — this is almost always CORS or a forbidden header, not a network outage.`,
      hint: 'Auto mode now falls back to the local Node proxy, which sends the full deepinfra.com header set for you.',
      rung: rungLabel, retryable: true,
    })
  }

  if (/mixed content|insecure/i.test(msg)) {
    return new DeepInfraError({
      kind: 'mixed',
      title: 'Mixed content blocked',
      message: 'An https page cannot call http (or vice-versa).',
      hint: 'Serve the app over http://localhost during development.', rung: rungLabel, retryable: false,
    })
  }

  return new DeepInfraError({
    kind: 'network',
    title: 'Network error',
    message: msg,
    hint: 'Check DNS/connectivity to api.deepinfra.com, or whether an extension is blocking the request.',
    rung: rungLabel, retryable: true,
  })
}

/** 200 OK but the body is HTML/JSON — typically a CDN challenge page. */
export function classifyUnexpectedPayload(contentType, bodyText, rungLabel) {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('text/html')) {
    return new DeepInfraError({
      kind: 'challenge',
      title: 'Challenge page instead of a stream',
      message: 'The edge returned HTML — usually a bot-check or an error page.',
      hint: 'Try proxy mode, or add an API key so the request looks like real API traffic.',
      body: (bodyText || '').slice(0, 400), rung: rungLabel, retryable: false,
    })
  }
  return new DeepInfraError({
    kind: 'payload',
    title: 'Unexpected response shape',
    message: `Content-Type was "${ct || 'unknown'}" and no SSE frames were found.`,
    hint: 'Open the diagnostics drawer — the first 400 bytes of the body are kept there.',
    body: (bodyText || '').slice(0, 400), rung: rungLabel, retryable: false,
  })
}
