// ══════════════════════════════════════════════════════════════
//  tests/session.test.ts — provider session establishment
//
//  Verifies the two providers that mint a credential before chatting:
//    · Upstage — the Next.js RSC pipeline in upstage_provider.py `_Creds`
//    · Mercury — GET /api/session in Inception.py
//  ...and that the corrected request headers actually reach the wire.
//
//  Every expectation here is taken from the Python source, not inferred. Where
//  an earlier revision of this codebase guessed (Upstage's header set,
//  DeepInfra's Origin, Mercury's session method) the source line is cited.
// ══════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findActionId,
  extractChunkRefs,
  parseTokenFromFlight,
  captureCreds,
  getCsrf,
  cookieHeader,
  loadCreds,
  clearCreds,
  saveCreds,
  ACTION_TOKEN,
  ACTION_INIT,
  MAX_CHUNK_SCAN,
} from '../src/lib/upstageSession.ts';
import { resolveRequest, fetchMercurySession, setUpstageCsrf, setMercuryToken } from '../src/lib/direct.ts';
import { FULL_HEADERS, splitHeaders } from '../src/lib/headers.ts';
import type { ChatRequest } from '../src/types.ts';

const upstageReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'Upstage',
  model: 'Solar Pro 3',
  modelId: 'solar-pro3',
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

// A realistic minified bundle line, 42 hex chars (ids were 40, now 42 — the
// extractor must not assume a length).
const ID42 = '002f44cb1234567890abcdef1234567890abcdef12';
const BUNDLE = `x=(self.webpackChunk=self.webpackChunk||[]).push([[123],{456:function(){createServerReference)("${ID42}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")}}]);`;

// ── _find_action_id (upstage_provider.py:590) ──────────────────
test('session: findActionId extracts the id by action NAME, any length 32-80 hex', () => {
  assert.equal(findActionId(BUNDLE, ACTION_TOKEN), ID42);
  // 40-hex (the older format) must still work — no fixed-length assumption.
  const id40 = 'a'.repeat(40);
  assert.equal(
    findActionId(`createServerReference)("${id40}",a.callServer,void 0,a.findSourceMapURL,"getConsoleCsrfToken")`, ACTION_TOKEN),
    id40,
  );
  // Too short / non-hex must NOT match.
  assert.equal(findActionId('createServerReference)("abc",a,b,c,"getConsoleCsrfToken")', ACTION_TOKEN), null);
  assert.equal(findActionId('createServerReference)("ZZZZ' + 'a'.repeat(38) + '",a,b,c,"getConsoleCsrfToken")', ACTION_TOKEN), null);
  assert.equal(findActionId('nothing here at all', ACTION_TOKEN), null);
});

test('session: findActionId pins the id to its OWN argument list (no cross-wiring)', () => {
  // Several actions minified onto one line — the common case. Asking for the
  // token action must not return the authAction id.
  const authId = 'b'.repeat(42);
  const twoOnOneLine =
    `createServerReference)("${authId}",x.callServer,void 0,x.findSourceMapURL,"authAction"),` +
    `createServerReference)("${ID42}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")`;
  assert.equal(findActionId(twoOnOneLine, ACTION_TOKEN), ID42, 'must return the token action id');
  assert.equal(findActionId(twoOnOneLine, ACTION_INIT), authId, 'must return the auth action id');
  assert.notEqual(findActionId(twoOnOneLine, ACTION_TOKEN), findActionId(twoOnOneLine, ACTION_INIT));
});

// ── chunk ref extraction (capture step 2) ──────────────────────
test('session: extractChunkRefs dedupes, sorts and rejects trailing junk', () => {
  const html = [
    '<script src="/_next/static/chunks/webpack-b.js"></script>',
    '<script src="/_next/static/chunks/main-app-a.js"></script>',
    '<script src="/_next/static/chunks/webpack-b.js"></script>', // duplicate
    'irrelevant text with no chunk',
  ].join('\n');
  const refs = extractChunkRefs(html);
  assert.deepEqual(refs, ['static/chunks/main-app-a.js', 'static/chunks/webpack-b.js'], 'deduped and sorted');
  assert.deepEqual(extractChunkRefs('<html>no chunks</html>'), []);
});

// ── flight text parsing (_try_get_token, :678) ─────────────────
test('session: parseTokenFromFlight reads the token out of Next.js flight text', () => {
  // Flight responses are line-oriented and NOT valid JSON as a whole.
  const flight = [
    '0:["$","div",null,{}]',
    '2:I[123,["456","static/chunks/x.js"],""]',
    '5:{"token":"eyJhbGciOiJIUzI1NiJ9.payload.sig"}',
    '6:null',
  ].join('\n');
  assert.equal(parseTokenFromFlight(flight), 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
  // Must keep scanning past lines that mention "token" but are not parseable.
  assert.equal(parseTokenFromFlight('x: {"note":"no token here\n3:{"token":"real-one"}'), 'real-one');
  assert.equal(parseTokenFromFlight('1:null\n2:[]'), null, 'no token → null, never a guess');
  assert.equal(parseTokenFromFlight(''), null);
});

test('session: cookieHeader serialises a jar and skips empty values', () => {
  assert.equal(cookieHeader({ a: '1', b: '2' }), 'a=1; b=2');
  assert.equal(cookieHeader({ a: '1', b: '', c: '3' }), 'a=1; c=3', 'empty values dropped');
  assert.equal(cookieHeader({}), '');
});

// ── the full capture flow, with fetch stubbed ──────────────────
function stubConsole(opts: {
  pageStatus?: number;
  chunks?: Record<string, string>;
  tokenFlight?: string;
  /** When set, the RSC POST 404s any next-action id not in this list — which is
   *  what real Next.js does for an id from a previous deploy. Without it the stub
   *  accepts ANY id and a stale-cache test silently passes via the verify path. */
  validActionIds?: string[];
  onRscPost?: (init: RequestInit, url: string) => void;
  onPageGet?: (url: string, init?: RequestInit) => void;
}) {
  const seen: string[] = [];
  const impl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/playground/chat') && (init?.method ?? 'GET') === 'GET') {
      opts.onPageGet?.(url, init);
      const status = opts.pageStatus ?? 200;
      if (status !== 200) return new Response('nope', { status });
      const html = Object.keys(opts.chunks ?? {})
        .map((c) => `<script src="/_next/${c}"></script>`)
        .join('\n');
      return new Response(html, { status: 200 });
    }
    if (url.includes('/_next/static/chunks/')) {
      const ref = url.slice(url.indexOf('static/chunks/'));
      const js = opts.chunks?.[ref];
      return js === undefined ? new Response('', { status: 404 }) : new Response(js, { status: 200 });
    }
    if (url.endsWith('/playground/chat') && init?.method === 'POST') {
      opts.onRscPost?.(init, url);
      const actionId = (init?.headers as Record<string, string>)?.['next-action'];
      if (opts.validActionIds && !opts.validActionIds.includes(actionId)) {
        // A stale id from a previous deploy: Next.js does not know this action.
        return new Response('{"error":"unknown action"}', { status: 404 });
      }
      return new Response(opts.tokenFlight ?? '5:{"token":"captured-jwt"}\n', { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { impl, seen };
}

test('session: captureCreds runs the whole RSC pipeline and posts the exact headers', async () => {
  clearCreds();
  let rscInit: RequestInit | undefined;
  const { impl, seen } = stubConsole({
    chunks: { 'static/chunks/main.js': BUNDLE },
    onRscPost: (init) => {
      rscInit = init;
    },
  });

  const r = await captureCreds({ fetchImpl: impl });
  assert.equal(r.failedStep, undefined, `capture failed at ${r.failedStep}: ${r.error}`);
  assert.equal(r.creds.csrf, 'captured-jwt');
  assert.equal(r.creds.actionToken, ID42, 'the action id must be the one found by name');
  assert.ok(r.creds.sessionId, 'a session id must always exist');
  assert.equal(r.chunksScanned, 1, 'stops scanning as soon as the action is found');

  // _rsc_post headers, verbatim from upstage_provider.py:660-668.
  const h = rscInit!.headers as Record<string, string>;
  assert.equal(h['accept'], 'text/x-component');
  assert.equal(h['content-type'], 'text/plain;charset=UTF-8');
  assert.equal(h['next-action'], ID42);
  assert.equal(rscInit!.body, '[]', 'the RSC POST body is literally "[]"');
  // No next-router-state-tree header — the Python source records that it was
  // verified empirically to be unnecessary.
  assert.ok(!('next-router-state-tree' in h), 'must not send next-router-state-tree');

  // Order of operations: page GET, chunk GET, then the RSC POST.
  assert.match(seen[0], /^GET .*\/playground\/chat$/);
  assert.ok(seen.some((s) => s.includes('static/chunks/main.js')), 'chunk must be fetched');
  assert.match(seen[seen.length - 1], /^POST .*\/playground\/chat$/);
});

test('session: capture reports the CHUNKS step when the page yields no refs (opaque browser response)', async () => {
  clearCreds();
  const impl = (async () => new Response('<html>nothing readable</html>', { status: 200 })) as typeof fetch;
  const r = await captureCreds({ fetchImpl: impl });
  assert.equal(r.failedStep, 'chunks');
  assert.match(r.error ?? '', /opaque|CORS|could not be read/i, 'must explain the browser-specific cause');
  assert.equal(r.creds.csrf, null, 'must NOT invent a token');
});

test('session: capture reports the ACTION-ID step and how many chunks it scanned', async () => {
  clearCreds();
  const { impl } = stubConsole({ chunks: { 'static/chunks/main.js': 'no actions declared here' } });
  const r = await captureCreds({ fetchImpl: impl });
  assert.equal(r.failedStep, 'action-id');
  assert.equal(r.chunksScanned, 1);
  assert.match(r.error ?? '', /getConsoleCsrfToken/);
});

test('session: capture reports the TOKEN step when the action answers without a token', async () => {
  clearCreds();
  const { impl } = stubConsole({ chunks: { 'static/chunks/main.js': BUNDLE }, tokenFlight: '1:null\n2:[]\n' });
  const r = await captureCreds({ fetchImpl: impl });
  assert.equal(r.failedStep, 'token');
  assert.match(r.error ?? '', /answered but no token/);
});

test('session: capture respects MAX_CHUNK_SCAN and stops early once found', async () => {
  clearCreds();
  assert.equal(MAX_CHUNK_SCAN, 80, 'upstage_provider.py:122 caps the scan at 80');
  // Build 100 chunks with the action only in the first — must stop at 1.
  const chunks: Record<string, string> = {};
  for (let i = 0; i < 100; i++) chunks[`static/chunks/c${String(i).padStart(3, '0')}.js`] = i === 0 ? BUNDLE : 'x';
  const { impl } = stubConsole({ chunks });
  const r = await captureCreds({ fetchImpl: impl });
  assert.equal(r.chunksScanned, 1, 'must break out of the scan as soon as the action is found');
  assert.equal(r.creds.csrf, 'captured-jwt');
});

test('session: getCsrf reuses cached credentials and verifies with one RSC POST', async () => {
  clearCreds();
  saveCreds({
    actionToken: ID42,
    actionInit: null,
    cookies: { session_id: 'cached-sid' },
    sessionId: 'cached-sid',
    csrf: 'stale',
    savedAt: null,
  });
  let posts = 0;
  const { impl } = stubConsole({
    chunks: { 'static/chunks/main.js': BUNDLE },
    tokenFlight: '5:{"token":"fresh-jwt"}\n',
    onRscPost: () => {
      posts++;
    },
  });
  const r = await getCsrf({ fetchImpl: impl });
  assert.ok('csrf' in r, `expected a token, got ${JSON.stringify(r)}`);
  if ('csrf' in r) {
    assert.equal(r.csrf, 'fresh-jwt', 'verify() returns a FRESH token, not the cached one');
    assert.equal(r.sessionId, 'cached-sid', 'the cached session_id is preserved');
  }
  assert.equal(posts, 1, 'a valid cache costs exactly one RSC POST — no page load, no chunk scan');
});

test('session: getCsrf re-captures when the cached action id is stale', async () => {
  clearCreds();
  saveCreds({ actionToken: 'f'.repeat(42), actionInit: null, cookies: {}, sessionId: 'old', csrf: 'old', savedAt: null });
  // Only ID42 is current; the cached ffff… id is from a previous deploy and the
  // server 404s it, forcing the re-capture path.
  const { impl, seen } = stubConsole({
    chunks: { 'static/chunks/main.js': BUNDLE },
    validActionIds: [ID42],
  });
  const r = await getCsrf({ fetchImpl: impl });
  assert.ok('csrf' in r, `expected a token after re-capture, got ${JSON.stringify(r)}`);
  assert.ok(seen.some((x) => x.startsWith('GET ') && x.includes('playground/chat')), 're-capture must reload the page');
  assert.ok(seen.filter((x) => x.startsWith('POST ')).length >= 2, 'one failed verify POST plus one capture POST');
  if ('csrf' in r) assert.equal(r.csrf, 'captured-jwt');
  assert.equal(loadCreds()?.actionToken, ID42, 'the new action id must be persisted');
});

test('session: getCsrf surfaces the failing step instead of returning nothing', async () => {
  clearCreds();
  const impl = (async () => new Response('<html>opaque</html>', { status: 200 })) as typeof fetch;
  const r = await getCsrf({ fetchImpl: impl });
  assert.ok('error' in r, 'must report an error');
  if ('error' in r) assert.match(r.error, /failed at step: chunks/);
});

// ── the corrected request headers actually reach the wire ──────
test('headers: Upstage sends the _stream_events set, including all three x- headers', () => {
  // upstage_provider.py _stream_events(): accept is */* — NOT text/event-stream.
  assert.equal(FULL_HEADERS.Upstage.accept, '*/*');
  assert.ok(!('Accept' in FULL_HEADERS.Upstage), 'the invented Accept: text/event-stream must be gone');
  assert.equal(FULL_HEADERS.Upstage['x-upstage-logging-enabled'], 'true');
  assert.equal(FULL_HEADERS.Upstage.origin, 'https://console.upstage.ai');
  assert.equal(FULL_HEADERS.Upstage.referer, 'https://console.upstage.ai/');

  // x-upstage-logging-enabled is settable; x-csrf-token/x-session-id are added at
  // runtime and must also survive the forbidden-header filter.
  const { settable } = splitHeaders('Upstage');
  assert.ok('x-upstage-logging-enabled' in settable);
  for (const h of ['x-csrf-token', 'x-session-id', 'x-upstage-logging-enabled']) {
    assert.ok(!/^(sec-|proxy-)/i.test(h), `${h} must be settable from a browser`);
  }
});

test('headers: a resolved Upstage request carries csrf, session id and logging flag', () => {
  setUpstageCsrf('jwt-abc');
  const r = resolveRequest(upstageReq(), { upstageSessionId: 'sid-123' });
  assert.equal(r.headers['x-csrf-token'], 'jwt-abc');
  assert.equal(r.headers['x-session-id'], 'sid-123');
  assert.equal(r.headers['x-upstage-logging-enabled'], 'true');
  assert.equal(r.headers.accept, '*/*');
  setUpstageCsrf('');
});

test('headers: DeepInfra Origin/Referer are g4f.dev, per DeepInfra.py:34', () => {
  assert.equal(FULL_HEADERS.DeepInfra.Origin, 'https://g4f.dev');
  assert.equal(FULL_HEADERS.DeepInfra.Referer, 'https://g4f.dev');
  assert.ok(
    !Object.values(FULL_HEADERS.DeepInfra).some((v) => v.includes('deepinfra.com')),
    'no header may claim deepinfra.com as its origin',
  );
});

// ── Mercury: GET /api/session (Inception.py:385) ───────────────
test('session: Mercury fetches its token with GET and no body', async () => {
  let method = '';
  let body: unknown;
  let url = '';
  const impl = (async (u: any, init?: RequestInit) => {
    url = String(u);
    method = init?.method ?? 'GET';
    body = init?.body;
    return new Response(JSON.stringify({ token: 'merc-tok-1' }), { status: 200 });
  }) as typeof fetch;

  const r = await fetchMercurySession({ fetchImpl: impl, skipDelay: true });
  assert.equal(r.token, 'merc-tok-1');
  assert.equal(method, 'GET', 'Inception.py:385 uses scraper.get() — a POST was invented earlier');
  assert.equal(body, undefined, 'a GET must carry no body');
  assert.equal(url, 'https://chat.inceptionlabs.ai/api/session');
});

test('session: Mercury reads exactly data.token and reports 429 as rate limiting', async () => {
  const ok = (async () => new Response(JSON.stringify({ sessionToken: 'wrong-field' }), { status: 200 })) as typeof fetch;
  const r1 = await fetchMercurySession({ fetchImpl: ok, skipDelay: true });
  assert.ok(!r1.token, 'must not fall back to a differently-named field');
  assert.match(r1.error ?? '', /no "token" field/);

  const limited = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
  const r2 = await fetchMercurySession({ fetchImpl: limited, skipDelay: true });
  assert.match(r2.error ?? '', /429/, '429 must be named as rate limiting, not a generic failure');
});

test('session: a resolved Mercury request carries x-session-token', () => {
  // A token stored by an earlier test (or pasted by the user) deliberately wins
  // over one passed in — manual input is the most explicit signal. Clear it so
  // this test exercises the passed-in path.
  setMercuryToken('');
  const r = resolveRequest(
    { provider: 'Mercury', model: 'm', modelId: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { mercuryToken: 'tok-from-session' },
  );
  assert.equal(r.headers['x-session-token'], 'tok-from-session');
  assert.equal(r.headers.accept, '*/*');
  assert.equal(r.url, 'https://chat.inceptionlabs.ai/api/chat');

  // And the documented precedence: a stored/pasted token wins.
  setMercuryToken('pasted-by-user');
  const r2 = resolveRequest(
    { provider: 'Mercury', model: 'm', modelId: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { mercuryToken: 'tok-from-session' },
  );
  assert.equal(r2.headers['x-session-token'], 'pasted-by-user', 'manual input outranks a captured token');
  setMercuryToken('');
});

// ── anonymous providers must not attempt any session work ──────
test('session: DeepInfra, mCloudFlare, Dolphin and LLMChat need no credential step', () => {
  for (const provider of ['DeepInfra', 'mCloudFlare', 'Dolphin', 'LLMChat'] as const) {
    const r = resolveRequest({
      provider,
      model: 'm',
      modelId: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tag: '@cf',
    });
    for (const h of Object.keys(r.headers)) {
      assert.ok(
        !/^x-(csrf|session)/i.test(h),
        `${provider} is anonymous in the Python source and must not send ${h}`,
      );
    }
  }
});
