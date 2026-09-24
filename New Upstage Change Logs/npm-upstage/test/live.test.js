/**
 * live.test.js — REAL network tests against console.upstage.ai /
 * ap-northeast-2.apistage.ai. No mocks. Gated by UPSTAGE_LIVE=1.
 *
 *   UPSTAGE_LIVE=1 npm run test:live
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpstageProvider } from '../src/provider.js';

const LIVE = process.env.UPSTAGE_LIVE === '1';
const skip = !LIVE;

test('live: credential capture (real HTTP)', { skip, timeout: 120_000 }, async () => {
  const up = new UpstageProvider();
  await up.connect();
  const token = await up._creds.verify();
  assert.ok(token, 'expected a CSRF token from the real console');
  assert.ok(up._creds.actionToken?.length >= 32);
});

test('live: realtime chat — tokens arrive before done', { skip, timeout: 120_000 }, async () => {
  const up = new UpstageProvider();
  const times = [];
  let doneAt = null;
  const t0 = Date.now();
  for await (const ev of up.stream({
    data: 'What is 2+2? One word.',
    maxTokens: 80,
  })) {
    if ((ev.kind === 'thinking' || ev.kind === 'content') && ev.text) {
      times.push(Date.now());
    } else if (ev.kind === 'done') {
      doneAt = Date.now();
    }
  }
  assert.ok(times.length >= 1, 'expected at least one token event');
  assert.ok(doneAt != null);
  assert.ok(times.every((t) => t <= doneAt));
  assert.ok(!up.last_response.includes(OPEN_TAG), 'no think markup in answer');
  assert.ok(up.last_usage?.ok);
  assert.ok(up.last_usage.elapsed_s > 0);
  assert.ok(Date.now() - t0 < 120_000);
});

test('live: search yields sources before done', { skip, timeout: 180_000 }, async () => {
  const up = new UpstageProvider();
  const kinds = [];
  for await (const ev of up.stream({
    data: 'What is the capital of France? In one word.',
    search: true,
    maxTokens: 120,
  })) {
    kinds.push(ev.kind);
  }
  assert.ok(kinds.includes('sources'), 'expected sources event');
  assert.ok(kinds.indexOf('sources') < kinds.indexOf('done'));
  assert.ok(up.last_sources.length >= 1);
  assert.ok(up.last_sources.every((s) => s.url.startsWith('http')));
});

const OPEN_TAG = '<' + 'think' + '>';
