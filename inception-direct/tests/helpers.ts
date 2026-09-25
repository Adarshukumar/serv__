/** Test helpers: build streaming Responses exactly as a network would deliver them. */

export const encoder = new TextEncoder();

/** One SSE frame. */
export function sse(payload: Record<string, unknown> | '[DONE]'): string {
  return `data: ${payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload)}\n\n`;
}

/** A `chat.completion.chunk` with the given delta content / finish reason / extras. */
export function chunk(content: string | null, finish: string | null = null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1745798400,
    model: 'mercury-2.5',
    choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
    ...extra,
  };
}

export function usageChunk(prompt = 10, completion = 20, reasoning = 5): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1745798400,
    model: 'mercury-2.5',
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: reasoning },
    },
  };
}

/** A Response whose body yields the given byte chunks, one per read(). */
export function streamResponse(
  chunks: Uint8Array[],
  init: ResponseInit = { status: 200, headers: { 'content-type': 'text/event-stream' } },
  options: { delayMs?: number; onCancel?: () => void; failAfter?: number; stallAfter?: number } = {},
): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.failAfter !== undefined && i >= options.failAfter) {
        controller.error(new TypeError('network error'));
        return;
      }
      if (options.stallAfter !== undefined && i >= options.stallAfter) {
        await new Promise(() => {}); // never resolves: a stalled connection
      }
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

export function apiErrorResponse(status: number, message: string, code: string | null, type = 'invalid_request_error'): Response {
  return jsonResponse({ error: { message, type, param: null, code } }, status);
}

export interface Recorded {
  url: string;
  init: RequestInit;
}

/** A programmable fetch: route by URL, record every call. */
export function mockFetch(handler: (url: URL, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fn = async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    return handler(new URL(input), init, calls.length);
  };
  return Object.assign(fn, { calls });
}

export function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
}

export function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
