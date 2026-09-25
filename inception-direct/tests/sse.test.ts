import { describe, expect, it } from 'vitest';
import { SSEDecoder } from '../src/site/sse';

function decodeAll(chunks: string[]): string[] {
  const decoder = new SSEDecoder();
  const out: string[] = [];
  for (const chunk of chunks) out.push(...decoder.push(chunk));
  out.push(...decoder.flush());
  return out;
}

const STREAM =
  'data: {"type":"start"}\n\n' +
  ': keep-alive comment\n\n' +
  'data: {"type":"text-delta","id":"t","delta":"Hello"}\n\n' +
  'event: message\nid: 7\nretry: 1000\ndata: {"type":"text-delta","id":"t","delta":" world"}\n\n' +
  'data: [DONE]\n\n';

const EXPECTED = ['{"type":"start"}', '{"type":"text-delta","id":"t","delta":"Hello"}', '{"type":"text-delta","id":"t","delta":" world"}', '[DONE]'];

describe('SSEDecoder', () => {
  it('decodes a well-formed stream', () => {
    expect(decodeAll([STREAM])).toEqual(EXPECTED);
  });

  it('gives identical results for every possible single split point', () => {
    for (let cut = 0; cut <= STREAM.length; cut++) {
      expect(decodeAll([STREAM.slice(0, cut), STREAM.slice(cut)])).toEqual(EXPECTED);
    }
  });

  it('survives one-character chunks', () => {
    expect(decodeAll([...STREAM])).toEqual(EXPECTED);
  });

  it('handles CRLF and lone CR line endings, including CR/LF split across chunks', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    expect(decodeAll([crlf])).toEqual(EXPECTED);
    for (let cut = 0; cut <= crlf.length; cut++) {
      expect(decodeAll([crlf.slice(0, cut), crlf.slice(cut)])).toEqual(EXPECTED);
    }
    expect(decodeAll([STREAM.replace(/\n/g, '\r')])).toEqual(EXPECTED);
  });

  it('joins multi-line data fields with newlines (spec behaviour)', () => {
    expect(decodeAll(['data: line one\ndata: line two\n\n'])).toEqual(['line one\nline two']);
  });

  it('accepts "data:" without a space and keeps further spaces', () => {
    expect(decodeAll(['data:{"a":1}\n\n', 'data:   padded\n\n'])).toEqual(['{"a":1}', '  padded']);
  });

  it('is lenient when the server forgets blank lines between JSON events', () => {
    const sloppy = 'data: {"type":"text-delta","delta":"a"}\ndata: {"type":"text-delta","delta":"b"}\ndata: [DONE]\n';
    expect(decodeAll([sloppy])).toEqual(['{"type":"text-delta","delta":"a"}', '{"type":"text-delta","delta":"b"}', '[DONE]']);
  });

  it('flushes a final event that has no trailing newline', () => {
    expect(decodeAll(['data: {"type":"finish"}'])).toEqual(['{"type":"finish"}']);
  });

  it('ignores comments and unknown fields', () => {
    expect(decodeAll([': ping\n\nfoo: bar\n\n'])).toEqual([]);
  });
});
