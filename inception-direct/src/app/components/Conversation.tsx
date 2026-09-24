import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { store } from '../controller';
import { useStore } from '../store';
import type { Message } from '../types';
import { ArrowDownIcon } from './Icons';
import { AssistantTurn, UserTurn } from './Turns';

interface Exchange {
  key: string;
  messages: Message[];
}

function toExchanges(messages: readonly Message[]): Exchange[] {
  const out: Exchange[] = [];
  for (const message of messages) {
    if (message.role === 'user' || out.length === 0) out.push({ key: message.id, messages: [message] });
    else out[out.length - 1]!.messages.push(message);
  }
  return out;
}

/** The reading column. Follows the stream while you're at the bottom; stays put if you scroll up. */
export function Conversation({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const messages = useStore(store, (s) => s.active?.messages ?? EMPTY);
  const conversationId = useStore(store, (s) => s.active?.id ?? null);
  const streamingId = useStore(store, (s) => s.streamingId);
  const exchanges = useMemo(() => toExchanges(messages), [messages]);
  const lastId = messages[messages.length - 1]?.id;
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distance < 140;
    setShowJump(!pinned.current && streamingId !== null);
  }, [scroller, streamingId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller, onScroll]);

  // New conversation → start at the bottom.
  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId, scroller]);

  // Follow the stream while pinned.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, scroller]);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowJump(false);
  };

  return (
    <div className="conversation">
      {exchanges.map((exchange) => (
        <article className="exchange" key={exchange.key}>
          {exchange.messages.map((message) =>
            message.role === 'user' ? (
              <UserTurn key={message.id} message={message} />
            ) : (
              <AssistantTurn key={message.id} message={message} isLast={message.id === lastId} />
            ),
          )}
        </article>
      ))}
      {showJump && (
        <button type="button" className="jump-button" onClick={jump}>
          <ArrowDownIcon size={15} /> Latest
        </button>
      )}
    </div>
  );
}

const EMPTY: Message[] = [];
