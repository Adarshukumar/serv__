// ══════════════════════════════════════════════════════════════
//  src/lib/mock.ts — offline provider simulator, running IN THE BROWSER
//
//  Emits raw SSE in each provider's EXACT wire format so the normalisers are
//  exercised end-to-end with no network, no credentials and no relay. This is
//  what makes the whole pipeline verifiable in an environment that cannot reach
//  any provider host (ARCHITECTURE.md §8).
//
//  The Upstage case is deliberately adversarial: it splits <think> tags ACROSS
//  chunk boundaries, interleaves search lifecycle events on chunks carrying no
//  `choices`, and puts `usage` on the same line as `finish_reason`.
// ══════════════════════════════════════════════════════════════

import type { WireFormat } from '../types';

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ANSWER = [
  'Direct mode is the default. ',
  'This request was built **in the browser** and sent to the provider\u2019s real URL, ',
  'so that URL is what appears in your DevTools network log. ',
  'No relay, no `/bridge/chat`, no Python.\n\n',
  '```js\nfetch("https://api.deepinfra.com/v1/openai/chat/completions", { method: "POST" })\n```\n\n',
  'Payload shape is a line-referenced port of each Python provider.',
];

const THINKING = [
  'The user wants the provider URLs hit directly from the browser. ',
  'Forbidden headers (Origin, Referer, Sec-Fetch-*) cannot be set from JS \u2014 ',
  'the browser fills them in itself, so cross-site is what the provider sees.',
];

async function* openAiDelta(): AsyncGenerator<string> {
  yield sse({ choices: [{ delta: { role: 'assistant' } }] });
  await sleep(120);
  for (const piece of ANSWER) {
    yield sse({ choices: [{ delta: { content: piece } }] });
    await sleep(45);
  }
  yield sse({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  yield DONE;
}

async function* workersRaw(): AsyncGenerator<string> {
  for (const piece of ANSWER) {
    // Workers AI returns a bare {"response": "..."} — no choices array at all.
    yield sse({ response: piece });
    await sleep(45);
  }
  yield DONE;
}

async function* reasoningDelta(): AsyncGenerator<string> {
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

async function* typedEvents(): AsyncGenerator<string> {
  for (const piece of THINKING) {
    yield sse({ type: 'reasoning-delta', delta: piece });
    await sleep(60);
  }
  // Mercury's progress placeholder \u2014 must NOT become a source.
  yield sse({ type: 'source-url', sourceId: '__searching__' });
  await sleep(200);
  yield sse({ type: 'source-url', sourceId: 'src_1', url: 'https://fetch.spec.whatwg.org/', title: 'Fetch Standard \u2014 forbidden header names' });
  yield sse({ type: 'source-url', sourceId: 'src_2', url: 'https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header', title: 'Fetch metadata request header \u2014 MDN' });
  for (const piece of ANSWER) {
    yield sse({ type: 'text-delta', delta: piece });
    await sleep(45);
  }
  yield DONE;
}

async function* upstageV3(): AsyncGenerator<string> {
  // 1. search lifecycle on a chunk with NO choices array
  yield sse({ search: { status: { action: 'search_start' }, search_queries: [{ query: 'forbidden request headers Sec-Fetch-Site' }] } });
  await sleep(400);
  yield sse({
    search: {
      status: { action: 'search_finish' },
      search_queries: [
        { url: 'https://fetch.spec.whatwg.org/', title: 'Fetch Standard' },
        { url: 'https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header', title: 'Fetch metadata request header \u2014 MDN' },
        { url: 'https://www.w3.org/TR/fetch-metadata/', title: 'Fetch Metadata Request Headers \u2014 W3C' },
      ],
    },
  });
  yield sse({ search: { status: { action: 'summarizing', description: 'Reading 3 sources' } } });
  await sleep(300);

  // 2. reasoning via the dedicated field
  for (const piece of THINKING) {
    yield sse({ choices: [{ delta: { reasoning_content: piece } }] });
    await sleep(60);
  }

  // 3. content with INLINE <think> tags split across chunk boundaries.
  //    "<thi" / "nk>\u2026</thi" / "nk>" is the pathological case the ThinkSplitter
  //    holdback logic exists for.
  const body = [
    'Direct mode is the default. ',
    'a browser cannot forge ',
    '<think>wait, let me double-check the spec',
    ' wording\u2026 yes, Sec- prefixed headers are forbidden.\n</think>\n\n',
    '`Origin`, `Referer` or `Sec-Fetch-*` \u2014 ',
    'the browser fills those in itself, so the provider sees ',
    '*cross-site*, and whether it answers is a CORS decision.',
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

export const MOCK_STREAMS: Record<WireFormat, () => AsyncGenerator<string>> = {
  'openai-delta': openAiDelta,
  'workers-raw': workersRaw,
  'reasoning-delta': reasoningDelta,
  'typed-events': typedEvents,
  'upstage-v3': upstageV3,
};

/** Async generator of raw SSE text chunks for a given wire format. */
export function mockStream(wire: WireFormat): AsyncGenerator<string> {
  const gen = MOCK_STREAMS[wire];
  if (!gen) throw new Error(`mock: unknown wire format "${wire}"`);
  return gen();
}
