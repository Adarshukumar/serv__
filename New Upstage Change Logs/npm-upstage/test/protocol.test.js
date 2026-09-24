/**
 * protocol.test.js — pure-logic unit tests (no network, no mock API).
 * These only assert the ported parsers/splitters/payload builder —
 * they never fabricate model responses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_THINK,
  OPEN_THINK,
  SessionUsage,
  Sources,
  ThinkSplitter,
  TurnUsage,
  buildPayload,
  findActionId,
  parseSSELine,
  resolveModel,
} from '../src/index.js';

test('SSE: content delta', () => {
  const line = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}';
  assert.deepEqual(parseSSELine(line), [['t-delta', 'hi']]);
});

test('SSE: reasoning delta', () => {
  const line = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"finish_reason":null}]}';
  assert.deepEqual(parseSSELine(line), [['r-delta', 'hmm']]);
});

test('SSE: done sentinel + finish stop', () => {
  assert.deepEqual(parseSSELine('data: [DONE]'), [['done', '']]);
  assert.deepEqual(
    parseSSELine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'),
    [['done', '']],
  );
});

test('SSE: usage with stop → usage then done', () => {
  const line =
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],' +
    '"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}';
  assert.deepEqual(parseSSELine(line).map((e) => e[0]), ['usage', 'done']);
});

test('SSE: search start/finish', () => {
  const start =
    'data: {"search":{"status":{"action":"search_start","description":"d"},' +
    '"search_queries":[{"query":"q1","results":[]}]}}';
  assert.deepEqual(parseSSELine(start), [['s-start', 'q1']]);

  const sq = [{ query: 'q', results: [{ url: 'u', title: 't' }] }];
  const fin = 'data: ' + JSON.stringify({
    search: { status: { action: 'search_finish', description: 'd' }, search_queries: sq },
  });
  assert.deepEqual(parseSSELine(fin), [['source', JSON.stringify(sq)]]);
});

test('SSE: garbage ignored', () => {
  assert.deepEqual(parseSSELine(''), []);
  assert.deepEqual(parseSSELine('event: ping'), []);
  assert.deepEqual(parseSSELine('data: {not json'), []);
});

test('ThinkSplitter: holds partial tags across feeds', () => {
  const sp = new ThinkSplitter();
  assert.deepEqual(sp.feed('ab'), []);
  assert.deepEqual(sp.feed('let me '), [['content', 'abl']]);
  assert.deepEqual(sp.flush(), [['content', 'et me ']]);
});

test('ThinkSplitter: inline block split across tokens', () => {
  const sp = new ThinkSplitter();
  const got = [
    ...sp.feed('hi' + OPEN_THINK.slice(0, 4)),
    ...sp.feed(OPEN_THINK.slice(4) + 'R1' + CLOSE_THINK.slice(0, 3)),
    ...sp.feed(CLOSE_THINK.slice(3) + 'ok'),
    ...sp.flush(),
  ];
  assert.equal(got.filter((k) => k[0] === 'content').map((k) => k[1]).join(''), 'hiok');
  assert.equal(got.filter((k) => k[0] === 'thinking').map((k) => k[1]).join(''), 'R1');
});

test('ThinkSplitter: ends inside think', () => {
  const sp = new ThinkSplitter();
  assert.deepEqual(sp.feed(OPEN_THINK + 'never closed'), [['thinking', 'never']]);
  assert.deepEqual(sp.flush(), [['thinking', ' closed']]);
});

test('Sources: dedup, index, snippet, formats', () => {
  const raw = JSON.stringify([{
    query: 'q',
    results: [
      { url: 'https://a.com', title: 'A', score: 0.9, content: 'x'.repeat(300) },
      { url: 'https://a.com', title: 'dup', score: 0.5, content: 'dup' },
      { url: '', title: 'skip', score: 0.1, content: 's' },
    ],
  }]);
  const got = Sources.parse([raw]);
  assert.equal(got.length, 1);
  assert.equal(got[0].index, 1);
  assert.ok(got[0].snippet.endsWith('...'));
  assert.ok(Sources.formatText(got).includes('📚 Sources (1)'));
  const blob = JSON.parse(Sources.formatJson(got));
  assert.deepEqual(Object.keys(blob.sources[0]).sort(), ['score', 'title', 'url']);
});

test('models: aliases + fuzzy', () => {
  assert.equal(resolveModel('pro2'), 'solar-pro2');
  assert.equal(resolveModel('mini'), 'upstage/solar-1-mini-chat');
  assert.equal(resolveModel('solar-pro4'), 'solar-pro4');
  assert.equal(resolveModel(''), 'solar-pro3');
});

test('payload: search flags + reasoning policy', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const p = buildPayload({ messages: msgs, model: 'solar-pro3', search: true });
  assert.equal(p.messages.at(-1).mode[0], 'search');
  assert.equal(p.search_provider, 'tavily');
  assert.equal(p.reasoning_effort, 'high');

  const q = buildPayload({ messages: msgs, model: 'solar-pro3', search: false });
  assert.equal(q.reasoning_effort, 'low');
  assert.equal(q.messages.at(-1).mode, undefined);

  const r = buildPayload({
    messages: msgs, model: 'solar-pro3', search: false, reasoning: 'high',
  });
  assert.equal(r.reasoning_effort, 'high');

  const mini = buildPayload({
    messages: msgs, model: 'upstage/solar-1-mini-chat', search: false,
  });
  assert.equal(mini.reasoning_effort, undefined);

  // input not mutated
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }]);
});

test('payload: syn-pro metadata + conversation_id + temperature priority', () => {
  const p = buildPayload({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'syn-pro',
    search: false,
    temperature: 0.9,
    maxTokens: 77,
  });
  assert.equal(p.metadata.quality, 4);
  assert.equal(p.temperature, 0.9);
  assert.equal(p.max_tokens, 77);
  assert.ok(p.conversation_id.length > 10);
  assert.equal(p.stream, true);
});

test('findActionId: pinned to own name among co-located actions', () => {
  const a1 = 'a'.repeat(42);
  const a2 = 'b'.repeat(42);
  const js =
    `createServerReference)("${a1}",x.callServer,void 0,x.findSourceMapURL,"authAction"),` +
    `createServerReference)("${a2}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")`;
  assert.equal(findActionId(js, 'getConsoleCsrfToken'), a2);
  assert.equal(findActionId(js, 'authAction'), a1);
  assert.equal(findActionId('nothing', 'getConsoleCsrfToken'), null);
});

test('usage department: estimate vs API tokens + report', () => {
  const u = new TurnUsage({ model: 'm', thinking_chars: 100, content_chars: 100, elapsed_s: 2 });
  assert.equal(u.tokens, 50);
  assert.equal(u.tokens_estimated, true);
  u.api_usage = { total_tokens: 77 };
  assert.equal(u.tokens, 77);
  assert.equal(u.tokens_estimated, false);

  const su = new SessionUsage();
  su.add(new TurnUsage({ model: 'm', content_chars: 40, elapsed_s: 1 }));
  assert.ok(su.formatReport().includes('TOTAL'));
  assert.ok(su.formatReport().includes('1 turns'));
});
