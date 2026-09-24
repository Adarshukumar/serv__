/** Test helpers: build streaming Responses exactly as a network would deliver them. */

export const encoder = new TextEncoder();

/** One SSE frame in the Vercel AI SDK UI-message-stream format. */
export function sse(event: Record<string, unknown> | '[DONE]'): string {
  return `data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`;
}

/** A Response whose body yields the given byte chunks, one per read(). */
export function streamResponse(
  chunks: Uint8Array[],
  init: ResponseInit = { status: 200, headers: { 'content-type': 'text/event-stream' } },
  options: { delayMs?: number; onCancel?: () => void } = {},
): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Response(body, init);
}

/** Split a string's UTF-8 bytes into chunks of `size` bytes (cuts through characters on purpose). */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const CHECKPOINT_HTML =
  '<!doctype html><html><head><title>Vercel Security Checkpoint</title></head><body>' +
  '<script src="/.well-known/vercel/security/static/challenge.v2.min.js"></script></body></html>';

export function checkpointResponse(): Response {
  return new Response(CHECKPOINT_HTML, {
    status: 429,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-vercel-mitigated': 'challenge', server: 'Vercel' },
  });
}

export const TOKEN = '1790265903.1d2aff6f6a28a0da4b8b7d0b2372fd6c.c1c993ca5bd2a1a6c3f1e8f7d9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';

export interface Recorded {
  url: string;
  init: RequestInit;
}

/** A programmable fetch: route by path, record every call. */
export function mockFetch(handler: (url: URL, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    return handler(new URL(input), init, calls.length);
  };
  return Object.assign(fn, { calls });
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
