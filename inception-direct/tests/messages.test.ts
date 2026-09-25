import { describe, expect, it } from 'vitest';
import { buildChatBody, toWireMessages } from '../src/site/messages';

describe('toWireMessages', () => {
  it('produces the web app’s UI-message shape', () => {
    const wire = toWireMessages([
      { id: 'u1', role: 'user', text: 'Hi' },
      { id: 'a1', role: 'assistant', text: 'Hello!' },
      { id: 'u2', role: 'user', text: 'Thanks' },
    ]);
    expect(wire).toEqual([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hello!', state: 'done' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
    ]);
  });

  it('prepends custom instructions to the first user turn only', () => {
    const wire = toWireMessages(
      [
        { id: 'u1', role: 'user', text: 'Question one' },
        { id: 'a1', role: 'assistant', text: 'Answer' },
        { id: 'u2', role: 'user', text: 'Question two' },
      ],
      '  Be brief.  ',
    );
    expect(wire[0]!.parts[0]!.text).toBe('[SYSTEM INSTRUCTION] Be brief.\n\nQuestion one');
    expect(wire[2]!.parts[0]!.text).toBe('Question two');
  });

  it('merges consecutive same-role turns and drops empty ones', () => {
    const wire = toWireMessages([
      { id: 'u1', role: 'user', text: 'First try' },
      { id: 'a1', role: 'assistant', text: '   ' },
      { id: 'u2', role: 'user', text: 'Second try' },
    ]);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'First try\n\nSecond try' }] });
  });

  it('assigns ids when missing', () => {
    const [message] = toWireMessages([{ role: 'user', text: 'x' }]);
    expect(message!.id).toMatch(/^[0-9A-Za-z]{16}$/);
  });
});

describe('buildChatBody', () => {
  it('matches the body the web app sends to /api/chat', () => {
    const messages = toWireMessages([{ id: 'u1', role: 'user', text: 'Hi' }]);
    const body = buildChatBody({ chatId: 'chat123', messages, thinking: 'high', webSearch: false, timezone: 'Asia/Calcutta' });
    expect(body).toEqual({
      reasoningEffort: 'high',
      webSearchEnabled: false,
      voiceMode: false,
      timezone: 'Asia/Calcutta',
      id: 'chat123',
      messages,
      trigger: 'submit-message',
    });
  });

  it('fills the timezone from Intl when not given', () => {
    const body = buildChatBody({ chatId: 'c', messages: [], thinking: 'medium', webSearch: true });
    expect(typeof body.timezone).toBe('string');
    expect(body.timezone.length).toBeGreaterThan(0);
  });
});
