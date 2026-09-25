import { describe, expect, it } from 'vitest';
import { parseChunk, parseUsage } from '../src/core/events';
import { chunk, usageChunk } from './helpers';

const j = (v: unknown) => JSON.stringify(v);

describe('parseChunk — chat.completion.chunk → typed events', () => {
  it('maps content deltas, and sends meta with the first chunk', () => {
    expect(parseChunk(j(chunk('Hello')), 'append')).toEqual([
      { type: 'meta', id: 'chatcmpl-test', model: 'mercury-2.5' },
      { type: 'delta', text: 'Hello' },
    ]);
  });

  it('ignores empty/role-only deltas in append mode', () => {
    const events = parseChunk(j({ ...chunk(''), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }), 'append');
    expect(events.filter((e) => e.type !== 'meta')).toEqual([]);
  });

  it('in diffusing (replace) mode, content is the whole canvas — even empty', () => {
    expect(parseChunk(j(chunk('The qxz brown fox')), 'replace').filter((e) => e.type === 'canvas')).toEqual([{ type: 'canvas', text: 'The qxz brown fox' }]);
    expect(parseChunk(j(chunk('')), 'replace').filter((e) => e.type === 'canvas')).toEqual([{ type: 'canvas', text: '' }]);
    // A null content (e.g. the final chunk) is not a canvas.
    expect(parseChunk(j(chunk(null, 'stop')), 'replace').some((e) => e.type === 'canvas')).toBe(false);
  });

  it('reports finish_reason, and a chunk can carry content + finish together', () => {
    const events = parseChunk(j(chunk('end.', 'length')), 'append').filter((e) => e.type !== 'meta');
    expect(events).toEqual([
      { type: 'delta', text: 'end.' },
      { type: 'finish', reason: 'length' },
    ]);
  });

  it('reads the reasoning summary from the final chunk', () => {
    const events = parseChunk(j(chunk(null, 'stop', { reasoning_summary: { content: 'Thought it through.', status: 'complete' } })), 'append');
    expect(events).toContainEqual({ type: 'reasoning-summary', summary: { content: 'Thought it through.', status: 'complete' } });
    const unavailable = parseChunk(j(chunk(null, 'stop', { reasoning_summary: { content: null, status: 'unavailable' } })), 'append');
    expect(unavailable).toContainEqual({ type: 'reasoning-summary', summary: { content: '', status: 'unavailable' } });
  });

  it('reads the usage chunk (empty choices) including nested details', () => {
    const events = parseChunk(j(usageChunk(100, 250, 80)), 'append');
    expect(events).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 100, completionTokens: 250, totalTokens: 350, reasoningTokens: 80, cachedTokens: 0 },
    });
    expect(events.some((e) => e.type === 'delta' || e.type === 'finish')).toBe(false);
  });

  it('accepts the flat usage fields of the non-streaming example too', () => {
    expect(parseUsage({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, reasoning_tokens: 3, cached_input_tokens: 2 })).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      reasoningTokens: 3,
      cachedTokens: 2,
    });
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage({ foo: 1 })).toBeNull();
  });

  it('surfaces warnings (e.g. temperature reset)', () => {
    expect(parseChunk(j({ ...chunk('x'), warning: 'temperature reset to 1' }), 'append')).toContainEqual({ type: 'warning', message: 'temperature reset to 1' });
  });

  it('turns an in-stream error object into an error event', () => {
    expect(parseChunk(j({ error: { message: 'Engine overloaded', type: 'server_error', code: 'engine_overloaded' } }), 'append')).toEqual([
      { type: 'error', message: 'Engine overloaded', code: 'engine_overloaded' },
    ]);
    expect(parseChunk(j({ error: 'plain' }), 'append')).toEqual([{ type: 'error', message: 'plain', code: undefined }]);
  });

  it('handles [DONE], blanks and garbage', () => {
    expect(parseChunk('[DONE]', 'append')).toEqual([{ type: 'done' }]);
    expect(parseChunk('  ', 'append')).toEqual([]);
    expect(parseChunk('{not json', 'append')).toEqual([]);
    expect(parseChunk('[1,2]', 'append')).toEqual([]);
  });

  it('uses choice index 0', () => {
    const payload = { ...chunk(null), choices: [{ index: 1, delta: { content: 'B' } }, { index: 0, delta: { content: 'A' } }] };
    expect(parseChunk(j(payload), 'append').filter((e) => e.type === 'delta')).toEqual([{ type: 'delta', text: 'A' }]);
  });
});
