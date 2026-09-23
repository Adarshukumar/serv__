// ══════════════════════════════════════════════════════════════
//  tests/normalizers.test.ts
//
//  Offline verification of the four provider wire formats and the SSE framer.
//  Fixtures reproduce the exact shapes the Python parsers were written against,
//  so a green run here means the TypeScript ports agree with the Python
//  semantics — no network, no credentials.
//
//  Run: npm test
// ══════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';

import { SSEFramer, DONE_SENTINEL } from '../src/lib/sse.ts';
import { createNormalizer, createDolphinNormalizer } from '../src/lib/normalizers.ts';
import { ThinkSplitter } from '../src/lib/thinkSplitter.ts';
import type { StreamEvent } from '../src/types.ts';

const J = (o: unknown) => JSON.stringify(o);

/** Push an array of raw SSE lines through framer + normaliser, then end(). */
function run(wire: Parameters<typeof createNormalizer>[0] | 'dolphin', lines: string[]): StreamEvent[] {
  const n = wire === 'dolphin' ? createDolphinNormalizer() : createNormalizer(wire);
  const framer = new SSEFramer();
  const out: StreamEvent[] = [];
  for (const line of lines) {
    for (const frame of framer.push(line + '\n')) {
      if (frame.type === 'done') {
        out.push({ kind: 'done', finishReason: DONE_SENTINEL });
        continue;
      }
      const parsed = JSON.parse(frame.payload);
      out.push(...n.push(parsed));
    }
  }
  for (const frame of framer.end()) {
    if (frame.type === 'data') out.push(...n.push(JSON.parse(frame.payload)));
  }
  out.push(...n.end());
  return out;
}

const text = (evs: StreamEvent[], kind: 'content' | 'thinking') =>
  evs.filter((e) => e.kind === kind).map((e) => (e as { text: string }).text).join('');

// ── A: OpenAI delta (DeepInfra) ─────────────────────────────
test('A/DeepInfra: delta.content becomes a content event', () => {
  const evs = run('openai-delta', [`data: ${J({ choices: [{ delta: { content: 'Hello' } }] })}`]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'Hello' }]);
});

test('A/DeepInfra: empty choices array yields nothing (Python: `if not choices`)', () => {
  const evs = run('openai-delta', [`data: ${J({ choices: [] })}`]);
  assert.deepEqual(evs, []);
});

test('A/DeepInfra: role-only first delta yields nothing', () => {
  const evs = run('openai-delta', [`data: ${J({ choices: [{ delta: { role: 'assistant' } }] })}`]);
  assert.deepEqual(evs, []);
});

test('A/DeepInfra: finish_reason is IGNORED (DeepInfra._parse_sse never reads it)', () => {
  const evs = run('openai-delta', [
    `data: ${J({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'x' }]);
});

test('A/Dolphin: finish_reason DOES terminate (Dolphin._parse_sse returns bool(finish))', () => {
  const evs = run('dolphin', [
    `data: ${J({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'content', text: 'x' },
    { kind: 'done', finishReason: 'stop' },
  ]);
});

test('A: [DONE] sentinel terminates', () => {
  const evs = run('openai-delta', ['data: [DONE]']);
  assert.deepEqual(evs, [{ kind: 'done', finishReason: '[DONE]' }]);
});

// ── B: Workers AI raw (mCloudFlare) ─────────────────────────
test('B/mCloudFlare: {"response": "..."} is the token field', () => {
  const evs = run('workers-raw', [`data: ${J({ response: 'chunk' })}`]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'chunk' }]);
});

test('B/mCloudFlare: missing response yields nothing', () => {
  assert.deepEqual(run('workers-raw', [`data: ${J({ foo: 1 })}`]), []);
});

// ── C: reasoning_content (LLMChat) ──────────────────────────
test('C/LLMChat: delta.reasoning_content becomes thinking', () => {
  const evs = run('reasoning-delta', [
    `data: ${J({ choices: [{ delta: { reasoning_content: 'let me think' } }] })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'thinking', text: 'let me think' }]);
});

test('C/LLMChat: falls back to the `reasoning` key when reasoning_content is absent', () => {
  const evs = run('reasoning-delta', [`data: ${J({ choices: [{ delta: { reasoning: 'alt' } }] })}`]);
  assert.deepEqual(evs, [{ kind: 'thinking', text: 'alt' }]);
});

test('C/LLMChat: reasoning_content wins over reasoning when both present', () => {
  const evs = run('reasoning-delta', [
    `data: ${J({ choices: [{ delta: { reasoning_content: 'primary', reasoning: 'ignored' } }] })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'thinking', text: 'primary' }]);
});

test('C/LLMChat: one chunk can carry BOTH reasoning and content, reasoning first', () => {
  const evs = run('reasoning-delta', [
    `data: ${J({ choices: [{ delta: { reasoning_content: 'why', content: 'answer' } }] })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'thinking', text: 'why' },
    { kind: 'content', text: 'answer' },
  ]);
});

test('C/LLMChat: bare {"response": "..."} fallback shape', () => {
  const evs = run('reasoning-delta', [`data: ${J({ response: 'plain' })}`]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'plain' }]);
});

test('C/LLMChat: empty delta with finish_reason surfaces done (the "meta" branch)', () => {
  const evs = run('reasoning-delta', [
    `data: ${J({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'done', finishReason: 'stop' }]);
});

// ── D: typed events (Mercury) ───────────────────────────────
test('D/Mercury: text-delta and reasoning-delta', () => {
  const evs = run('typed-events', [
    `data: ${J({ type: 'reasoning-delta', delta: 'pondering' })}`,
    `data: ${J({ type: 'text-delta', delta: 'result' })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'thinking', text: 'pondering' },
    { kind: 'content', text: 'result' },
  ]);
});

test('D/Mercury: source-url becomes a source event with id/url/title', () => {
  const evs = run('typed-events', [
    `data: ${J({ type: 'source-url', sourceId: 's1', url: 'https://a.test/x', title: 'A' })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'source', sources: [{ url: 'https://a.test/x', id: 's1', title: 'A' }] },
  ]);
});

test('D/Mercury: __searching__ placeholder is NOT a source, it is a status', () => {
  const evs = run('typed-events', [
    `data: ${J({ type: 'source-url', sourceId: '__searching__' })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'status', phase: 'searching' }]);
});

test('D/Mercury: source-url without a url is dropped', () => {
  assert.deepEqual(run('typed-events', [`data: ${J({ type: 'source-url', sourceId: 's2' })}`]), []);
});

test('D/Mercury: empty delta emits nothing (Python guards `if d else None`)', () => {
  assert.deepEqual(run('typed-events', [`data: ${J({ type: 'text-delta', delta: '' })}`]), []);
});

test('D/Mercury: unknown event type is ignored', () => {
  assert.deepEqual(run('typed-events', [`data: ${J({ type: 'mystery', delta: 'x' })}`]), []);
});

// ── E: Upstage v3 ───────────────────────────────────────────
test('E/Upstage: search_start carries the query as a status detail', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ search: { status: { action: 'search_start' }, search_queries: [{ query: 'kimi k2' }] } })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'status', phase: 'searching', detail: 'kimi k2' }]);
});

test('E/Upstage: summarizing status', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ search: { status: { action: 'summarizing', description: 'reading 5 pages' } } })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'status', phase: 'summarizing', detail: 'reading 5 pages' }]);
});

test('E/Upstage: search_finish maps search_queries to sources', () => {
  const evs = run('upstage-v3', [
    `data: ${J({
      search: {
        status: { action: 'search_finish' },
        search_queries: [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test' }],
      },
    })}`,
  ]);
  assert.deepEqual(evs, [
    {
      kind: 'source',
      sources: [
        { url: 'https://a.test', title: 'A' },
        { url: 'https://b.test' },
      ],
    },
  ]);
});

test('E/Upstage: search branch is only taken when choices is ABSENT', () => {
  // Python: `if obj.get("choices") is None and search:` — a chunk with both
  // goes down the content path, not the search path.
  const evs = run('upstage-v3', [
    `data: ${J({
      choices: [{ delta: { content: 'hi' } }],
      search: { status: { action: 'search_start' } },
    })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'hi' }]);
});

test('E/Upstage: reasoning_content and content in one chunk, reasoning first', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ choices: [{ delta: { reasoning_content: 'think', content: 'say' } }] })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'thinking', text: 'think' },
    { kind: 'content', text: 'say' },
  ]);
});

test('E/Upstage: usage arrives BEFORE done on the same line (Python: "done LAST")', () => {
  const evs = run('upstage-v3', [
    `data: ${J({
      choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'content', text: 'x' },
    { kind: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { kind: 'done', finishReason: 'stop' },
  ]);
});

test('E/Upstage: an all-zero usage block is suppressed (Python requires a non-zero count)', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}`,
  ]);
  assert.deepEqual(evs, [{ kind: 'content', text: 'x' }]);
});

test('E/Upstage: <think> tags inside content are split out', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ choices: [{ delta: { content: 'before<think>inside</think>after' } }] })}`,
  ]);
  assert.deepEqual(evs, [
    { kind: 'content', text: 'before' },
    { kind: 'thinking', text: 'inside' },
    { kind: 'content', text: 'after' },
  ]);
});

test('E/Upstage: a <think> tag SPLIT ACROSS CHUNKS is still handled', () => {
  const evs = run('upstage-v3', [
    `data: ${J({ choices: [{ delta: { content: 'A<thi' } }] })}`,
    `data: ${J({ choices: [{ delta: { content: 'nk>reasoning</thi' } }] })}`,
    `data: ${J({ choices: [{ delta: { content: 'nk>B' } }] })}`,
  ]);
  assert.equal(text(evs, 'content'), 'AB');
  assert.equal(text(evs, 'thinking'), 'reasoning');
});

test('E/Upstage: a partial close tag held back is released by flush()', () => {
  const n = createNormalizer('upstage-v3');
  const out: StreamEvent[] = [];
  out.push(...n.push({ choices: [{ delta: { content: 'tail</thi' } }] }));
  out.push(...n.end());
  assert.equal(text(out, 'content'), 'tail</thi');
});

test('E/Upstage: an UNCLOSED <think> at stream end flushes as thinking', () => {
  const n = createNormalizer('upstage-v3');
  const out: StreamEvent[] = [];
  out.push(...n.push({ choices: [{ delta: { content: '<think>dangling' } }] }));
  out.push(...n.end());
  assert.equal(text(out, 'thinking'), 'dangling');
  assert.equal(text(out, 'content'), '');
});

// ── ThinkSplitter unit behaviour ────────────────────────────
// Expectations below are taken from the ORIGINAL PYTHON, executed directly
// (see scripts/gen_thinksplitter_fixtures.py). The holdback arithmetic is
// counter-intuitive, so it is spelled out:
//   open  tag "<think>"  len 7 → holds back up to 6 chars when OUTSIDE a think block
//   close tag "</think>" len 8 → holds back up to 7 chars when INSIDE one
// A short feed can therefore emit nothing at all, or emit only a prefix.

test('ThinkSplitter: holds back the last 6 chars in case they begin a split open tag', () => {
  const s = new ThinkSplitter();
  // 'hello<thi' is 9 chars; 9 > 6 so it emits the first 3 and holds 'lo<thi'.
  assert.deepEqual(s.feed('hello<thi'), [['content', 'hel']]);
  // 'lo<thi' + 'nk>world' = 'lo<think>world'; the tag resolves at index 2.
  assert.deepEqual(s.feed('nk>world'), [['content', 'lo']]);
  // 'world' is now inside an unclosed think block, held back (5 <= 7).
  assert.deepEqual(s.flush(), [['thinking', 'world']]);
});

test('ThinkSplitter: a feed shorter than the holdback emits nothing', () => {
  const s = new ThinkSplitter();
  assert.deepEqual(s.feed('x'), []); // 1 char, holdback is 6
  assert.deepEqual(s.flush(), [['content', 'x']]);
});

test('ThinkSplitter: flush releases a held fragment with the right kind', () => {
  const s = new ThinkSplitter();
  // 'abc</th' is 7 chars; OUTSIDE a think block the holdback is 6 (the OPEN tag),
  // so it emits 'a' and holds 'bc</th'. A stray close tag is literal text.
  assert.deepEqual(s.feed('abc</th'), [['content', 'a']]);
  assert.deepEqual(s.flush(), [['content', 'bc</th']]);
});

test('ThinkSplitter: flush on empty buffer returns nothing', () => {
  assert.deepEqual(new ThinkSplitter().flush(), []);
});

test('ThinkSplitter: a lone open tag is consumed and emits nothing', () => {
  // PYTHON GROUND TRUTH: ['<think>'] + flush -> []
  // The tag resolves at index 0, so nothing precedes it; the splitter enters
  // thinking mode with an empty buffer, and flush() on an empty buffer is [].
  const s = new ThinkSplitter();
  assert.deepEqual([...s.feed('<think>'), ...s.flush()], []);
  assert.equal(s.inThinking, true);
});

test('ThinkSplitter: a stray close tag outside a think block stays literal text', () => {
  // PYTHON GROUND TRUTH: ['</think>'] + flush -> [['content','</'],['content','think>']]
  // Outside a think block only the OPEN tag is searched for, so '</think>' is
  // ordinary text; the 6-char holdback splits it across feed() and flush().
  const s = new ThinkSplitter();
  const out = [...s.feed('</think>'), ...s.flush()];
  assert.deepEqual(out, [
    ['content', '</'],
    ['content', 'think>'],
  ]);
  assert.equal(out.map(([, v]) => v).join(''), '</think>');
});

test('ThinkSplitter: balanced blocks classify correctly', () => {
  const s = new ThinkSplitter();
  const out = [...s.feed('before<think>inside</think>after'), ...s.flush()];
  assert.deepEqual(out, [
    ['content', 'before'],
    ['thinking', 'inside'],
    ['content', 'after'],
  ]);
});

test('ThinkSplitter: reset() clears buffer and state', () => {
  const s = new ThinkSplitter();
  s.feed('abc<think>def');
  assert.equal(s.inThinking, true);
  s.reset();
  assert.equal(s.inThinking, false);
  assert.deepEqual(s.flush(), []);
});

// ── SSE framer ──────────────────────────────────────────────
test('SSEFramer: reassembles a line split across chunks', () => {
  const f = new SSEFramer();
  assert.deepEqual(f.push('data: {"a"'), []);
  const frames = f.push(':1}\n');
  assert.deepEqual(frames, [{ type: 'data', payload: '{"a":1}' }]);
});

test('SSEFramer: handles CRLF line endings', () => {
  const f = new SSEFramer();
  assert.deepEqual(f.push('data: {"a":1}\r\n'), [{ type: 'data', payload: '{"a":1}' }]);
});

test('SSEFramer: accepts both `data:X` and `data: X`', () => {
  const f = new SSEFramer();
  assert.deepEqual(f.push('data:{"a":1}\ndata: {"b":2}\n'), [
    { type: 'data', payload: '{"a":1}' },
    { type: 'data', payload: '{"b":2}' },
  ]);
});

test('SSEFramer: skips comments, blank lines, event:/id:/retry: fields', () => {
  const f = new SSEFramer();
  assert.deepEqual(f.push(': ping\n\nevent: message\nid: 7\nretry: 100\ndata: {"a":1}\n'), [
    { type: 'data', payload: '{"a":1}' },
  ]);
});

test('SSEFramer: [DONE] produces a done frame and stops further parsing', () => {
  const f = new SSEFramer();
  const frames = f.push('data: [DONE]\ndata: {"a":1}\n');
  assert.deepEqual(frames, [{ type: 'done' }]);
  assert.equal(f.done, true);
});

test('SSEFramer: end() releases an unterminated final line', () => {
  const f = new SSEFramer();
  f.push('data: {"a":1}');
  assert.deepEqual(f.end(), [{ type: 'data', payload: '{"a":1}' }]);
});

test('SSEFramer: end() on a blank buffer returns nothing', () => {
  const f = new SSEFramer();
  f.push('data: {"a":1}\n');
  assert.deepEqual(f.end(), []);
});

// ── robustness: malformed input must not throw ──────────────
test('robustness: non-object payloads are ignored, never thrown on', () => {
  for (const wire of ['openai-delta', 'workers-raw', 'reasoning-delta', 'typed-events', 'upstage-v3'] as const) {
    const n = createNormalizer(wire);
    for (const bad of [null, undefined, 42, 'string', [], { choices: 'not-an-array' }, { choices: [null] }]) {
      assert.doesNotThrow(() => n.push(bad), `${wire} threw on ${J(bad)}`);
      assert.doesNotThrow(() => n.end(), `${wire} end() threw`);
    }
  }
});
