import { describe, expect, it } from 'vitest';
import {
  buildChatRequest,
  buildFollowUpsRequest,
  buildHandshakeRequest,
  parseFollowUps,
  toApiMessages,
  type ChatTurn,
} from '../src/core/messages';

describe('toApiMessages', () => {
  it('sends custom instructions as a real system message, first', () => {
    const out = toApiMessages([{ role: 'user', text: 'Hi' }], '  Be brief.  ');
    expect(out).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('omits an empty system message', () => {
    expect(toApiMessages([{ role: 'user', text: 'Hi' }], '   ')).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('drops empty turns and merges consecutive same-role turns', () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: '   ' }, // a failed answer
      { role: 'user', text: 'Second question' },
      { role: 'assistant', text: 'Answer' },
      { role: 'user', text: 'Third' },
    ];
    expect(toApiMessages(turns)).toEqual([
      { role: 'user', content: 'First question\n\nSecond question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Third' },
    ]);
  });

  it('keeps the text exactly (no trimming inside code)', () => {
    const text = '```\n  indented\n```\n';
    expect(toApiMessages([{ role: 'user', text }])[0]!.content).toBe(text);
  });
});

describe('request bodies', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  it('chat: streaming with usage, effort and a length budget — only documented params', () => {
    const body = buildChatRequest({ model: 'mercury-2.5', messages, effort: 'high', diffusing: false, maxTokens: 16384, reasoningSummary: true });
    expect(body).toEqual({
      model: 'mercury-2.5',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      max_completion_tokens: 16384,
      reasoning_summary: true,
    });
  });

  it('chat: diffusing only when on; no reasoning summary for "instant"', () => {
    const body = buildChatRequest({ model: 'mercury-2', messages, effort: 'instant', diffusing: true, maxTokens: 4096, reasoningSummary: true });
    expect(body.diffusing).toBe(true);
    expect('reasoning_summary' in body).toBe(false);
    const off = buildChatRequest({ model: 'mercury-2', messages, effort: 'low', diffusing: false, maxTokens: 4096, reasoningSummary: false });
    expect('diffusing' in off).toBe(false);
    expect('reasoning_summary' in off).toBe(false);
  });

  it('handshake: the smallest real completion', () => {
    expect(buildHandshakeRequest('mercury-2.5')).toEqual({
      model: 'mercury-2.5',
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 1,
      reasoning_effort: 'instant',
      stream: false,
    });
  });

  it('follow-ups: structured output over a clipped transcript of the last turns', () => {
    const long = 'x'.repeat(10_000);
    const turns: ChatTurn[] = [
      { role: 'user', text: 'old' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'Why is the sky blue?' },
      { role: 'assistant', text: long },
      { role: 'user', text: 'And sunsets?' },
      { role: 'assistant', text: 'Longer path through air.' },
    ];
    const body = buildFollowUpsRequest('mercury-2.5', turns) as { messages: { role: string; content: string }[]; response_format: { type: string; json_schema: { name: string } } };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('follow_ups');
    const transcript = body.messages[1]!.content;
    expect(transcript).not.toContain('old answer'); // only the last four turns
    expect(transcript).toContain('User: Why is the sky blue?');
    expect(transcript.length).toBeLessThan(6_000); // long turns are clipped
  });
});

describe('parseFollowUps', () => {
  it('reads the structured JSON', () => {
    expect(parseFollowUps('{"follow_ups":["What about Mars?","Why red at sunset?","Is it the same on the Moon?"]}')).toEqual([
      'What about Mars?',
      'Why red at sunset?',
      'Is it the same on the Moon?',
    ]);
  });

  it('tolerates fences, bare arrays, bullets, duplicates and junk', () => {
    expect(parseFollowUps('```json\n["One question?", "one question?", "", 7, "Two?"]\n```')).toEqual(['One question?', 'Two?']);
    expect(parseFollowUps('1. First thing?\n- “Second thing?”\n• Third thing?\n• Fourth thing?')).toEqual(['First thing?', 'Second thing?', 'Third thing?']);
    expect(parseFollowUps('')).toEqual([]);
  });
});
