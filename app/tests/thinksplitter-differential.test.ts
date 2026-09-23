// ══════════════════════════════════════════════════════════════
//  tests/thinksplitter-differential.test.ts
//
//  DIFFERENTIAL TEST. The expected values in tests/fixtures/thinksplitter.json
//  were produced by EXECUTING the original Python ThinkSplitter extracted from
//  `New Upstage Change Logs/upstage_provider.py` (see
//  scripts/gen_thinksplitter_fixtures.py). So this asserts the TypeScript port
//  is equivalent to the Python original — not to a test author's guess.
//
//  815 cases: 15 hand-picked edge cases, 400 unbalanced fuzz (stray/split tags),
//  400 balanced fuzz. Balanced cases additionally assert the lossless invariant:
//  concatenated output == input with tags removed.
//
//  Regenerate fixtures: python3 scripts/gen_thinksplitter_fixtures.py
// ══════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ThinkSplitter } from '../src/lib/thinkSplitter.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'thinksplitter.json'), 'utf-8'),
) as {
  open_tag: string;
  close_tag: string;
  cases: { chunks: string[]; flush: boolean; balanced: boolean; expected: [string, string][] }[];
};

/** Run one fixture case through the TypeScript port. */
function runCase(chunks: string[], flush: boolean): [string, string][] {
  const s = new ThinkSplitter(FIXTURES.open_tag, FIXTURES.close_tag);
  const out: [string, string][] = [];
  for (const c of chunks) out.push(...s.feed(c));
  if (flush) out.push(...s.flush());
  return out;
}

test(`differential: TS port matches Python on all ${FIXTURES.cases.length} cases`, () => {
  const failures: string[] = [];
  FIXTURES.cases.forEach((c, i) => {
    const actual = runCase(c.chunks, c.flush);
    if (JSON.stringify(actual) !== JSON.stringify(c.expected)) {
      if (failures.length < 5) {
        failures.push(
          `case ${i}: chunks=${JSON.stringify(c.chunks)} flush=${c.flush}\n` +
            `    python=${JSON.stringify(c.expected)}\n` +
            `    ts    =${JSON.stringify(actual)}`,
        );
      }
    }
  });
  assert.deepEqual(failures, [], `${failures.length} divergences from Python:\n${failures.join('\n')}`);
});

test('differential: balanced cases satisfy the lossless invariant in TS too', () => {
  const balanced = FIXTURES.cases.filter((c) => c.balanced);
  assert.ok(balanced.length > 0, 'no balanced fixtures found');
  const failures: string[] = [];
  for (const c of balanced) {
    const out = runCase(c.chunks, true);
    const joined = out.map(([, v]) => v).join('');
    const stripped = c.chunks
      .join('')
      .split(FIXTURES.open_tag)
      .join('')
      .split(FIXTURES.close_tag)
      .join('');
    if (joined !== stripped && failures.length < 5) {
      failures.push(
        `chunks=${JSON.stringify(c.chunks)}\n    joined  =${JSON.stringify(joined)}\n    stripped=${JSON.stringify(stripped)}`,
      );
    }
  }
  assert.deepEqual(failures, [], `lossless invariant violated:\n${failures.join('\n')}`);
});

test('differential: thinking/content classification agrees with Python', () => {
  // Kind sequence (ignoring text) must match exactly — this is what decides
  // whether reasoning lands in the thinking panel or the answer body.
  const failures: string[] = [];
  FIXTURES.cases.forEach((c, i) => {
    const actualKinds = runCase(c.chunks, c.flush).map(([k]) => k).join(',');
    const expectedKinds = c.expected.map(([k]) => k).join(',');
    if (actualKinds !== expectedKinds && failures.length < 5) {
      failures.push(`case ${i}: python kinds=[${expectedKinds}] ts kinds=[${actualKinds}]`);
    }
  });
  assert.deepEqual(failures, [], `kind mismatch:\n${failures.join('\n')}`);
});
