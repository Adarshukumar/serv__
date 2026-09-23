// ══════════════════════════════════════════════════════════════
//  src/lib/upstageSession.ts — Upstage's credential pipeline, ported
//
//  Faithful TypeScript port of class `_Creds` and `_find_action_id` in
//  New Upstage Change Logs/upstage_provider.py. Line references are given so
//  every step can be diffed against the original.
//
//  THE FLOW (upstage_provider.py:37-51, capture() at :693)
//  ────────────────────────────────────────────────────────
//  The console is a Next.js app. Its client JS bundles embed every server-action
//  id, e.g.
//      createServerReference)("002f44cb…d5", …, "getConsoleCsrfToken")
//
//    1. load cached credentials
//    2. verify the CSRF token with one RSC POST
//    3. valid?  → instant start
//    4. invalid → pure-HTTP re-capture:
//         a. GET /playground/chat   → session cookies + JS chunk list
//         b. GET it again with RSC:1 → extra chunk refs (insurance)
//         c. scan chunks for the action id BY NAME (ids change on redeploy,
//            names do not — so never assume a fixed id length)
//         d. RSC POST with data "[]"  → parse {"token": …} out of flight text
//         e. save cookies + action ids
//
//  ── THE HARD LIMIT IN A BROWSER, stated precisely ──────────────
//  Steps (a)-(d) are cross-origin reads of console.upstage.ai. A browser blocks
//  them unless that origin sends Access-Control-Allow-Origin for this page, and
//  it cannot read Set-Cookie at all. Step (e) therefore yields empty cookies in
//  a browser.
//
//  That matters because the chat request goes to a DIFFERENT SITE
//  (ap-northeast-2.apistage.ai) with the console's cookies attached MANUALLY by
//  the Python client (`cookies=dict(self._creds.cookies)`). A browser sends only
//  apistage.ai's own cookies on that request and has no way to read the console's.
//  This is a cookie-scope constraint, not a CORS guess: Upstage cannot complete
//  auth from a pure browser SPA. `capture()` is implemented anyway so the relay
//  fallback can run the identical code, and so a browser attempt reports exactly
//  which step failed instead of failing silently.
// ══════════════════════════════════════════════════════════════

import { ENDPOINTS } from './headers.ts';

const CONSOLE = 'https://console.upstage.ai';
const CHAT_EP = '/playground/chat';
const CHAT_URL = `${CONSOLE}${CHAT_EP}`;

/** upstage_provider.py:117-119 — action NAMES are stable across builds. */
export const ACTION_TOKEN = 'getConsoleCsrfToken'; // → {"token": "<jwt>"}
export const ACTION_INIT = 'authAction'; // → flight "1:null" (kept for parity)

/** upstage_provider.py:122 — cap on how many JS chunks we scan. */
export const MAX_CHUNK_SCAN = 80;

export interface UpstageCreds {
  actionToken: string | null;
  actionInit: string | null;
  cookies: Record<string, string>;
  sessionId: string;
  /** The JWT itself, harvested by the last successful verify/capture. */
  csrf: string | null;
  savedAt: string | null;
}

const LS_KEY = 'upstage.creds.v3';

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export function emptyCreds(): UpstageCreds {
  return { actionToken: null, actionInit: null, cookies: {}, sessionId: uuid(), csrf: null, savedAt: null };
}

// ── persistence (localStorage in a browser, memory elsewhere) ──
const mem = new Map<string, string>();
function lsGet(k: string): string {
  const g = globalThis as { localStorage?: Storage };
  try {
    if (g.localStorage) return g.localStorage.getItem(k) ?? '';
  } catch {
    /* disabled storage */
  }
  return mem.get(k) ?? '';
}
function lsSet(k: string, v: string): void {
  const g = globalThis as { localStorage?: Storage };
  try {
    if (g.localStorage) return void g.localStorage.setItem(k, v);
  } catch {
    /* disabled storage */
  }
  mem.set(k, v);
}

/** _Creds.load() — upstage_provider.py:619 */
export function loadCreds(): UpstageCreds | null {
  const raw = lsGet(LS_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<UpstageCreds>;
    const c: UpstageCreds = {
      actionToken: d.actionToken ?? null,
      actionInit: d.actionInit ?? null,
      cookies: d.cookies ?? {},
      sessionId: d.cookies?.session_id ?? d.sessionId ?? uuid(),
      csrf: d.csrf ?? null,
      savedAt: d.savedAt ?? null,
    };
    // Python returns bool(self.action_token) — no action id, nothing loaded.
    return c.actionToken ? c : null;
  } catch {
    return null;
  }
}

/** _Creds.save() — upstage_provider.py:632 */
export function saveCreds(c: UpstageCreds): void {
  lsSet(LS_KEY, JSON.stringify({ ...c, savedAt: new Date().toISOString() }));
}

export function clearCreds(): void {
  lsSet(LS_KEY, '');
}

// ── _find_action_id() — upstage_provider.py:590 ────────────────
/**
 * Extract a Next.js server-action id from a client JS bundle BY ITS DECLARED
 * NAME. The regex pins the id to its own argument list (exactly 3 unquoted args
 * before the name) so that when several actions are minified onto one line the
 * ids cannot be cross-wired. No fixed length assumption: ids were 40 hex, now
 * 42 — extracting by name survives future format changes.
 */
export function findActionId(jsText: string, actionName: string): string | null {
  const re = new RegExp(
    `createServerReference\\)\\("([a-f0-9]{32,80})"(?:,[^,"]+){3},"${actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`,
  );
  const m = jsText.match(re);
  return m ? m[1] : null;
}

/** capture() step 2 — chunk refs from the page HTML and its RSC payload. */
export function extractChunkRefs(text: string): string[] {
  return [...new Set(text.match(/static\/chunks\/[^\\\s\],]+\.js/g) ?? [])].sort();
}

/**
 * _try_get_token() — upstage_provider.py:678. The response is Next.js flight
 * text, not JSON: find the line containing "token", then JSON-parse from its
 * first `{`.
 */
export function parseTokenFromFlight(body: string): string | null {
  for (const line of body.trim().split('\n')) {
    if (!line.includes('"token"')) continue;
    const idx = line.indexOf('{');
    if (idx < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(idx)) as { token?: string };
      if (parsed.token) return parsed.token;
    } catch {
      continue; // keep scanning — flight lines are often partial
    }
  }
  return null;
}

/** Serialise a cookie jar into a Cookie header (Node/relay path only). */
export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export interface CaptureResult {
  creds: UpstageCreds;
  /** Which step failed, named exactly as the Python flow names it. */
  failedStep?: 'page' | 'chunks' | 'action-id' | 'token';
  error?: string;
  chunksScanned?: number;
}

/**
 * _Creds.capture() + _rsc_post() + _try_get_token(), as one flow.
 *
 * `transportCookies` lets the Node relay attach a real cookie jar, which a
 * browser cannot do. In a browser this runs identically and reports the step
 * where the platform stops it.
 */
export async function captureCreds(
  opts: { cookies?: Record<string, string>; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CaptureResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const cookies: Record<string, string> = { ...(opts.cookies ?? {}) };
  const creds = emptyCreds();
  const cookieHdr = () => cookieHeader(cookies);

  const rscPost = async (actionId: string): Promise<string> => {
    // _rsc_post() — upstage_provider.py:659. NOTE: no next-router-state-tree
    // header is needed; the Python source records that this was verified
    // empirically (the token action answers with and without it).
    const res = await doFetch(CHAT_URL, {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': actionId,
        ...(cookieHdr() ? { cookie: cookieHdr() } : {}),
      },
      body: '[]',
      signal: opts.signal,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`RSC POST returned HTTP ${res.status}`);
    return res.text();
  };

  try {
    // (a) page load — sets the session cookies we need
    const page = await doFetch(CHAT_URL, { signal: opts.signal, credentials: 'include' });
    if (!page.ok) return { creds, failedStep: 'page', error: `GET ${CHAT_URL} returned HTTP ${page.status}` };
    const html = await page.text();

    // (b) merge chunk refs from the page + its RSC payload
    let chunkRefs = extractChunkRefs(html);
    try {
      const rsc = await doFetch(CHAT_URL, { headers: { RSC: '1' }, signal: opts.signal, credentials: 'include' });
      if (rsc.ok) {
        const rscText = await rsc.text();
        chunkRefs = [...new Set([...chunkRefs, ...extractChunkRefs(rscText)])].sort();
      }
    } catch {
      /* RSC scan is insurance only, exactly as in the Python source */
    }

    if (!chunkRefs.length) {
      return {
        creds,
        failedStep: 'chunks',
        chunksScanned: 0,
        error:
          `No JS chunk references found in ${CHAT_URL}. In a browser this almost always means the ` +
          `response was opaque: console.upstage.ai did not grant this origin CORS access, so the HTML ` +
          `could not be read. Check DevTools → Network → console.upstage.ai.`,
      };
    }

    // (c) scan chunks for the action id, BY NAME
    let actionToken: string | null = null;
    let actionInit: string | null = null;
    let scanned = 0;
    for (const ref of chunkRefs.slice(0, MAX_CHUNK_SCAN)) {
      scanned += 1;
      try {
        const r = await doFetch(`${CONSOLE}/_next/${ref}`, { signal: opts.signal, credentials: 'include' });
        if (!r.ok) continue;
        const js = await r.text();
        if (!actionToken && js.includes(ACTION_TOKEN)) actionToken = findActionId(js, ACTION_TOKEN);
        if (!actionInit && js.includes(ACTION_INIT)) actionInit = findActionId(js, ACTION_INIT);
        if (actionToken) break;
      } catch {
        continue;
      }
    }

    if (!actionToken) {
      return {
        creds,
        failedStep: 'action-id',
        chunksScanned: scanned,
        error:
          `Could not find '${ACTION_TOKEN}' in any of ${scanned} scanned JS chunks — either the console ` +
          `changed structure, or the chunk requests were blocked. Delete the cached credentials and retry.`,
      };
    }

    creds.actionToken = actionToken;
    creds.actionInit = actionInit;
    if (!cookies.session_id) cookies.session_id = uuid();
    creds.cookies = cookies;
    creds.sessionId = cookies.session_id;

    // (d) prove the action works + harvest a first token
    const body = await rscPost(actionToken);
    const token = parseTokenFromFlight(body);
    if (!token) {
      return {
        creds,
        failedStep: 'token',
        chunksScanned: scanned,
        error: `Token action '${actionToken.slice(0, 12)}…' answered but no token in response (len=${body.length}).`,
      };
    }
    creds.csrf = token;
    saveCreds(creds);
    return { creds, chunksScanned: scanned };
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    return {
      creds,
      failedStep: 'page',
      error: /Failed to fetch|NetworkError|ERR_BLOCKED|CORS/i.test(msg)
        ? `Could not reach ${CONSOLE} — the browser blocked a cross-origin read. ${msg}`
        : msg,
    };
  }
}

/**
 * _get_csrf() — upstage_provider.py:875, with the same auto-refresh shape:
 * verify the cached token first, re-capture if it is stale, and raise only when
 * both attempts fail.
 */
export async function getCsrf(
  opts: { cookies?: Record<string, string>; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ csrf: string; sessionId: string; cookies: Record<string, string> } | { error: string }> {
  const cached = loadCreds();
  if (cached?.actionToken) {
    // verify() — one RSC POST with the cached action id
    try {
      const doFetch = opts.fetchImpl ?? fetch;
      const res = await doFetch(CHAT_URL, {
        method: 'POST',
        headers: {
          accept: 'text/x-component',
          'content-type': 'text/plain;charset=UTF-8',
          'next-action': cached.actionToken,
          ...(cookieHeader(cached.cookies) ? { cookie: cookieHeader(cached.cookies) } : {}),
        },
        body: '[]',
        signal: opts.signal,
        credentials: 'include',
      });
      if (res.ok) {
        const token = parseTokenFromFlight(await res.text());
        if (token) {
          const next = { ...cached, csrf: token };
          saveCreds(next);
          return { csrf: token, sessionId: next.sessionId, cookies: next.cookies };
        }
      }
    } catch {
      /* fall through to re-capture, exactly as the Python does */
    }
  }

  const r = await captureCreds(opts);
  if (r.creds.csrf) {
    return { csrf: r.creds.csrf, sessionId: r.creds.sessionId, cookies: r.creds.cookies };
  }
  return {
    error:
      `Could not obtain an Upstage CSRF token (failed at step: ${r.failedStep ?? 'unknown'}). ` +
      `${r.error ?? ''}`,
  };
}

export const UPSTAGE_CONSTANTS = { CONSOLE, CHAT_EP, CHAT_URL, API: ENDPOINTS.Upstage };
