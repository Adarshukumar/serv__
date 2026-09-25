import { describe, expect, it } from 'vitest';
import { changedShare, diffCanvas } from '../src/app/diffusion';

describe('diffCanvas — which words just settled', () => {
  it('marks only the words that changed at the same position', () => {
    const segments = diffCanvas('The qzx brown fox jumps', 'The quick brown fox jumps');
    expect(segments).toEqual([
      { text: 'The ', fresh: false },
      { text: 'quick ', fresh: true },
      { text: 'brown fox jumps', fresh: false },
    ]);
  });

  it('joins neighbouring changes into one run and keeps the text intact', () => {
    const next = 'alpha beta gamma delta';
    const segments = diffCanvas('alpha xx yy delta', next);
    expect(segments.map((s) => s.text).join('')).toBe(next);
    expect(segments.filter((s) => s.fresh).map((s) => s.text.trim())).toEqual(['beta gamma']);
  });

  it('treats the first frame as all fresh, and an empty frame as nothing', () => {
    expect(diffCanvas('', 'hello world')).toEqual([{ text: 'hello world', fresh: true }]);
    expect(diffCanvas('hello', '')).toEqual([]);
  });

  it('handles a canvas that grows (new words at the end are fresh)', () => {
    const segments = diffCanvas('one two', 'one two three');
    expect(segments.at(-1)).toEqual({ text: 'three', fresh: true });
  });

  it('preserves newlines and multi-byte text', () => {
    const next = 'नमस्ते 👋\n— café ✓';
    expect(diffCanvas('नमस्ते xx\n— café ✓', next).map((s) => s.text).join('')).toBe(next);
  });

  it('changedShare measures how much of the canvas moved', () => {
    expect(changedShare('a b c d', 'a b c d')).toBe(0);
    expect(changedShare('a b c d', 'a B c D')).toBe(0.5);
  });
});
