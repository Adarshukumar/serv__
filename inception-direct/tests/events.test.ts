import { describe, expect, it } from 'vitest';
import { SourceCollector, parseStreamPayload } from '../src/core/events';

const p = (value: unknown) => parseStreamPayload(JSON.stringify(value));

describe('parseStreamPayload', () => {
  it('maps text and reasoning deltas', () => {
    expect(p({ type: 'text-delta', id: '0', delta: 'Hi' })).toEqual({ type: 'text-delta', delta: 'Hi' });
    expect(p({ type: 'reasoning-delta', id: 'r', delta: 'hmm' })).toEqual({ type: 'reasoning-delta', delta: 'hmm' });
    expect(p({ type: 'text-delta', id: '0', delta: '' })).toBeNull();
  });

  it('keeps sources and recognises the searching / search-error markers (title or sourceId)', () => {
    expect(p({ type: 'source-url', sourceId: 's1', url: 'https://a.example/x', title: 'A' })).toEqual({
      type: 'source',
      source: { id: 's1', url: 'https://a.example/x', title: 'A' },
    });
    expect(p({ type: 'source-url', sourceId: 'x', url: '', title: '__searching__' })).toEqual({ type: 'searching' });
    expect(p({ type: 'source-url', sourceId: '__searching__', url: 'about:blank', title: '' })).toEqual({ type: 'searching' });
    expect(p({ type: 'source-url', sourceId: 'y', url: '', title: '__search_error__' })).toEqual({ type: 'search-error' });
    expect(p({ type: 'source-url', sourceId: 'z', title: 'no url' })).toBeNull();
  });

  it('surfaces error events instead of dropping them (Python dropped them)', () => {
    expect(p({ type: 'error', errorText: 'Model overloaded' })).toEqual({ type: 'error', message: 'Model overloaded' });
    expect(p({ type: 'error' })).toEqual({ type: 'error', message: 'The model reported an error.' });
  });

  it('maps lifecycle events and the [DONE] terminator', () => {
    expect(p({ type: 'start', messageId: 'm1' })).toEqual({ type: 'start', messageId: 'm1' });
    expect(p({ type: 'finish' })).toEqual({ type: 'finish', finishReason: undefined });
    expect(p({ type: 'abort' })).toEqual({ type: 'abort' });
    expect(parseStreamPayload('[DONE]')).toEqual({ type: 'done' });
  });

  it('ignores structural and unknown events, and junk', () => {
    for (const type of ['start-step', 'finish-step', 'text-start', 'text-end', 'reasoning-start', 'reasoning-end', 'data-usage', 'tool-input-start']) {
      expect(p({ type })).toBeNull();
    }
    expect(parseStreamPayload('not json')).toBeNull();
    expect(parseStreamPayload('[1,2]')).toBeNull();
    expect(parseStreamPayload('')).toBeNull();
  });
});

describe('SourceCollector', () => {
  it('keeps every distinct source in arrival order (Python kept only the first)', () => {
    const c = new SourceCollector();
    c.add({ id: '1', url: 'https://a.example/one', title: 'One' });
    c.add({ id: '2', url: 'https://b.example/two', title: 'Two' });
    c.add({ id: '3', url: 'https://c.example/three', title: 'Three' });
    expect(c.list().map((s) => s.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('dedupes by URL (ignoring fragments and trailing slashes) and fills in missing titles', () => {
    const c = new SourceCollector();
    expect(c.add({ id: '1', url: 'https://a.example/page/', title: '' })).toBe(true);
    expect(c.add({ id: '2', url: 'https://a.example/page#section', title: 'Page' })).toBe(false);
    expect(c.list()).toEqual([{ id: '1', url: 'https://a.example/page/', title: 'Page' }]);
  });
});
