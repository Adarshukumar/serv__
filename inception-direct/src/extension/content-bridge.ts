/**
 * Content script for chat.inceptionlabs.ai tabs. Inert unless the extension talks to it:
 *
 * 1. Probe — "is this tab past the security checkpoint, and does /api/session answer?"
 *    Used while the user passes the Vercel checkpoint, and to pick a tab for the bridge.
 * 2. Bridge — run fetches for the app page from inside the site's origin (fallback
 *    transport), streaming the response back over a runtime Port.
 *
 * Only same-origin requests are executed, so this can never act as an open proxy,
 * and only the extension itself can open the Port.
 */
import {
  BRIDGE_PORT_NAME,
  PROBE_MESSAGE,
  type BridgeReply,
  type BridgeRequest,
  type ProbeResult,
} from '../platform/bridgeProtocol';

const SESSION_PATH = '/api/session';

function onCheckpointPage(): boolean {
  return (
    /security checkpoint|just a moment/i.test(document.title) ||
    document.querySelector('script[src*="vercel/security"], script[src*="challenge-platform"]') !== null
  );
}

async function probe(): Promise<ProbeResult> {
  const base = { title: document.title, url: location.href };
  if (onCheckpointPage()) return { ...base, ready: false, reason: 'checkpoint' };
  try {
    const res = await fetch(SESSION_PATH, { credentials: 'same-origin' });
    if (!res.ok) return { ...base, ready: false, reason: `session ${res.status}` };
    const json = (await res.json().catch(() => null)) as { token?: unknown } | null;
    const ready = typeof json?.token === 'string' && json.token.length > 0;
    return { ...base, ready, reason: ready ? 'ok' : 'no token' };
  } catch {
    return { ...base, ready: false, reason: 'network' };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || (message as { t?: unknown }).t !== PROBE_MESSAGE) return false;
  probe().then(sendResponse, () => sendResponse({ ready: false, reason: 'probe failed' } satisfies ProbeResult));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BRIDGE_PORT_NAME) return;
  const inflight = new Map<string, AbortController>();

  const send = (reply: BridgeReply) => {
    try {
      port.postMessage(reply);
    } catch {
      // Port closed — the app page went away.
    }
  };

  const run = async (req: Extract<BridgeRequest, { t: 'req' }>) => {
    const controller = new AbortController();
    inflight.set(req.id, controller);
    try {
      const target = new URL(req.url, location.origin);
      if (target.origin !== location.origin) throw new Error('The bridge only performs same-origin requests.');
      const res = await fetch(target.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        credentials: 'same-origin',
        signal: controller.signal,
      });
      send({ t: 'head', id: req.id, status: res.status, statusText: res.statusText, headers: [...res.headers.entries()] });
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text) send({ t: 'chunk', id: req.id, data: text });
        }
        const tail = decoder.decode();
        if (tail) send({ t: 'chunk', id: req.id, data: tail });
      }
      send({ t: 'end', id: req.id });
    } catch (error) {
      send({
        t: 'fail',
        id: req.id,
        message: error instanceof Error ? error.message : String(error),
        aborted: controller.signal.aborted,
      });
    } finally {
      inflight.delete(req.id);
    }
  };

  port.onMessage.addListener((message: BridgeRequest) => {
    if (message.t === 'abort') {
      inflight.get(message.id)?.abort();
      inflight.delete(message.id);
    } else if (message.t === 'req') {
      void run(message);
    }
  });

  port.onDisconnect.addListener(() => {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  });
});
