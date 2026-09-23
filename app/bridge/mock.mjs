// ══════════════════════════════════════════════════════════════
//  bridge/mock.mjs — offline provider simulator
//
//  Emits raw SSE in each provider's EXACT wire format, so the browser's
//  normalisers are exercised end-to-end with no network and no credentials.
//  This is what makes the UI verifiable in an environment that cannot reach any
//  provider host (ARCHITECTURE.md §8).
//
//  The Upstage case is deliberately adversarial: it splits <think> tags
//  ACROSS chunk boundaries, interleaves search lifecycle events on chunks that
//  carry no `choices`, and puts `usage` on the same line as `finish_reason`.
// ══════════════════════════════════════════════════════════════

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWER = [
  'Short answer: ',
  'the bridge exists because a browser **cannot** forge `Origin`, `Referer` or ',
  '`Sec-Fetch-*` — the Fetch spec makes them forbidden headers. ',
  'Node has no such restriction, so it runs on *your* machine and dials the ',
  'provider from *your* IP.\n\n',
  '```js\nfetch("http://127.0.0.1:8787/bridge/chat", { method: "POST" })\n```\n\n',
  'No hosted server, no datacenter IP, nothing to get blocked.',
];

const THINKING = [
  'The user wants the providers called from their own IP. ',
  'Direct browser calls are blocked by forbidden headers. ',
  'A local Node bridge solves it without a hosted backend.',
];

async function* openAiDelta() {
  yield sse({ choices: [{ delta: { role: 'assistant' } }] });
  await sleep(120);
  for (const piece of ANSWER) {
    yield sse({ choices: [{ delta: { content: piece } }] });
    await sleep(45);
  }
  yield sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  yield DONE;
}

async function* workersRaw() {
  for (const piece of ANSWER) {
    // Workers AI returns a bare {"response": "..."} — no choices array at all.
    yield sse({ response: piece });
    await sleep(45);
  }
  yield DONE;
}

async function* reasoningDelta() {
  for (const piece of THINKING) {
    yield sse({ choices: [{ delta: { reasoning_content: piece } }] });
    await sleep(60);
  }
  // Some backends emit reasoning and content in the SAME chunk.
  yield sse({ choices: [{ delta: { reasoning_content: ' Now the answer. ', content: ANSWER[0] } }] });
  await sleep(60);
  for (const piece of ANSWER.slice(1)) {
    yield sse({ choices: [{ delta: { content: piece } }] });
    await sleep(45);
  }
  yield sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  yield DONE;
}

async function* typedEvents() {
  for (const piece of THINKING) {
    yield sse({ type: 'reasoning-delta', delta: piece });
    await sleep(60);
  }
  // Mercury's progress placeholder — must NOT become a source.
  yield sse({ type: 'source-url', sourceId: '__searching__' });
  await sleep(200);
  yield sse({ type: 'source-url', sourceId: 'src_1', url: 'https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header', title: 'Fetch metadata request header — MDN' });
  yield sse({ type: 'source-url', sourceId: 'src_2', url: 'https://www.w3.org/TR/fetch-metadata/', title: 'Fetch Metadata Request Headers — W3C' });
  for (const piece of ANSWER) {
    yield sse({ type: 'text-delta', delta: piece });
    await sleep(45);
  }
  yield DONE;
}

async function* upstageV3() {
  // 1. search lifecycle on a chunk with NO choices array
  yield sse({ search: { status: { action: 'search_start' }, search_queries: [{ query: 'forbidden request headers Sec-Fetch-Site' }] } });
  await sleep(400);
  yield sse({ search: { status: { action: 'search_finish' }, search_queries: [
    { url: 'https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header', title: 'Fetch metadata request header — MDN' },
    { url: 'https://www.w3.org/TR/fetch-metadata/', title: 'Fetch Metadata Request Headers — W3C' },
    { url: 'https://corsfix.com/blog/change-sec-fetch-headers', title: 'How to Change Sec-Fetch Headers' },
  ] } });
  yield sse({ search: { status: { action: 'summarizing', description: 'Reading 3 sources' } } });
  await sleep(300);

  // 2. reasoning via the dedicated field
  for (const piece of THINKING) {
    yield sse({ choices: [{ delta: { reasoning_content: piece } }] });
    await sleep(60);
  }

  // 3. content with INLINE <think> tags split across chunk boundaries.
  //    "<thi" / "nk>…</thi" / "nk>" is the pathological case the ThinkSplitter
  //    holdback logic exists for.
  const body = [
    'Short answer: ',
    'a browser cannot forge ',
    '<think>wait, let me double-check the spec',
    ' wording\u2026 yes, Sec- prefixed headers are forbidden.\n</think>\n\n',
    '`Origin`, `Referer` or `Sec-Fetch-*`.\n\n',
    'Node has no such restriction, so the bridge runs on ',
    '*your* machine and dials the provider from *your* IP.',
  ];
  for (const piece of body) {
    yield sse({ choices: [{ delta: { content: piece } }] });
    await sleep(50);
  }

  // 4. usage on the SAME line as finish_reason — done must come last
  yield sse({
    choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1284, completion_tokens: 317, total_tokens: 1601 },
  });
  yield DONE;
}

export const MOCK_STREAMS = {
  'openai-delta': openAiDelta,
  'workers-raw': workersRaw,
  'reasoning-delta': reasoningDelta,
  'typed-events': typedEvents,
  'upstage-v3': upstageV3,
};

/** Async generator of raw SSE text chunks for a given wire format. */
export function mockStream(wire) {
  const gen = MOCK_STREAMS[wire];
  if (!gen) throw new Error(`mock: unknown wire format "${wire}"`);
  return gen();
}
